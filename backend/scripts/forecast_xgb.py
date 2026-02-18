#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any, Dict, List

import joblib
import numpy as np
import pandas as pd


DEFAULT_FEATURE_COLUMNS = [
    "temp",
    "humi",
    "pres",
    "hour_sin",
    "hour_cos",
    "dow",
    "temp_lag1",
    "temp_lag2",
    "temp_lag3",
    "temp_roll3_mean",
    "temp_roll6_mean",
    "humi_lag1",
    "humi_lag2",
    "humi_lag3",
    "humi_roll3_mean",
    "humi_roll6_mean",
    "pres_lag1",
    "pres_lag2",
    "pres_lag3",
    "pres_roll3_mean",
    "pres_roll6_mean",
]


def _fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def _load_stdin_payload() -> Dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        _fail(f"Invalid JSON input: {exc}")

    if not isinstance(payload, dict):
        _fail("Input payload must be a JSON object.")

    return payload


def _parse_now(raw_now: Any) -> pd.Timestamp:
    if isinstance(raw_now, str) and raw_now.strip():
        parsed = pd.to_datetime(raw_now, utc=True, errors="coerce")
        if pd.notna(parsed):
            return parsed

    return pd.Timestamp.utcnow().tz_convert("UTC")


def _build_hourly_history(rows: List[Dict[str, Any]]) -> pd.DataFrame:
    if not rows:
        return pd.DataFrame(columns=["temp", "humi", "pres"])

    df = pd.DataFrame(rows)
    if "time" not in df.columns:
        return pd.DataFrame(columns=["temp", "humi", "pres"])

    df["time"] = pd.to_datetime(df["time"], utc=True, errors="coerce")
    for col in ("temp", "humi", "pres"):
        if col not in df.columns:
            df[col] = np.nan
        df[col] = pd.to_numeric(df[col], errors="coerce")

    df = df.dropna(subset=["time"])
    if df.empty:
        return pd.DataFrame(columns=["temp", "humi", "pres"])

    df = df.sort_values("time").drop_duplicates(subset=["time"])
    df = df.set_index("time")[["temp", "humi", "pres"]]

    # Mirror the notebook preprocessing: hourly resample + light interpolation.
    df_h = df.resample("1h").mean()
    df_h[["temp", "humi", "pres"]] = df_h[["temp", "humi", "pres"]].interpolate(
        method="time", limit=3
    )
    df_h = df_h.ffill(limit=2)

    bounds = {"temp": (10.0, 45.0), "humi": (0.0, 100.0), "pres": (930.0, 1070.0)}
    for col, (lo, hi) in bounds.items():
        bad = (df_h[col] < lo) | (df_h[col] > hi)
        df_h.loc[bad, col] = np.nan

    spike_thresh = {"temp": 5.0, "humi": 30.0, "pres": 10.0}
    for col, threshold in spike_thresh.items():
        jumps = df_h[col].diff().abs()
        df_h.loc[jumps > threshold, col] = np.nan

    df_h[["temp", "humi", "pres"]] = df_h[["temp", "humi", "pres"]].interpolate(
        method="time", limit=3
    )
    df_h = df_h.ffill(limit=2).bfill(limit=2)
    df_h = df_h.dropna(subset=["temp", "humi", "pres"])
    return df_h


def _time_features(ts: pd.Timestamp) -> tuple[float, float, int]:
    hour = ts.hour
    hour_sin = math.sin(2 * math.pi * hour / 24.0)
    hour_cos = math.cos(2 * math.pi * hour / 24.0)
    dow = ts.dayofweek
    return hour_sin, hour_cos, dow


def _feature_row(series_df: pd.DataFrame, ts: pd.Timestamp, feature_columns: List[str]) -> pd.DataFrame:
    temp = series_df["temp"]
    humi = series_df["humi"]
    pres = series_df["pres"]

    hour_sin, hour_cos, dow = _time_features(ts)

    row: Dict[str, float] = {
        "temp": float(temp.iloc[-1]),
        "humi": float(humi.iloc[-1]),
        "pres": float(pres.iloc[-1]),
        "hour_sin": float(hour_sin),
        "hour_cos": float(hour_cos),
        "dow": float(dow),
    }

    for col, values in (("temp", temp), ("humi", humi), ("pres", pres)):
        row[f"{col}_lag1"] = float(values.iloc[-1])
        row[f"{col}_lag2"] = float(values.iloc[-2])
        row[f"{col}_lag3"] = float(values.iloc[-3])
        row[f"{col}_roll3_mean"] = float(values.iloc[-3:].mean())
        row[f"{col}_roll6_mean"] = float(values.iloc[-6:].mean())

    frame = pd.DataFrame([row], index=[ts])
    return frame.reindex(columns=feature_columns)


def _future_index(mode: str, now_ts: pd.Timestamp, series_df: pd.DataFrame) -> pd.DatetimeIndex:
    last_ts = series_df.index.max()
    anchor = max(last_ts, now_ts.floor("h"))

    if mode == "hourly":
        end = now_ts.normalize() + pd.Timedelta(hours=23)
    else:
        end = now_ts.floor("h") + pd.Timedelta(days=7)

    if anchor >= end:
        return pd.DatetimeIndex([], tz=now_ts.tz)

    return pd.date_range(start=anchor + pd.Timedelta(hours=1), end=end, freq="1h")


def _forecast(
    models: Dict[str, Any],
    history_df: pd.DataFrame,
    mode: str,
    now_ts: pd.Timestamp,
    feature_columns: List[str],
) -> List[Dict[str, float | str]]:
    if len(history_df) < 6:
        _fail("Not enough history to run forecast (need at least 6 hourly points).")

    series_df = history_df[["temp", "humi", "pres"]].copy()
    targets = ("temp", "humi", "pres")

    future_idx = _future_index(mode, now_ts, series_df)
    predictions: List[Dict[str, float | str]] = []

    for ts in future_idx:
        features = _feature_row(series_df, ts, feature_columns)

        temp_pred = float(models["temp"].predict(features)[0])
        humi_pred = float(models["humi"].predict(features)[0])
        pres_pred = float(models["pres"].predict(features)[0])

        temp_pred = float(np.clip(temp_pred, -20.0, 60.0))
        humi_pred = float(np.clip(humi_pred, 0.0, 100.0))
        pres_pred = float(np.clip(pres_pred, 900.0, 1100.0))

        series_df.loc[ts, list(targets)] = [temp_pred, humi_pred, pres_pred]

        predictions.append(
            {
                "time": ts.isoformat(),
                "temp": temp_pred,
                "humi": humi_pred,
                "pres": pres_pred,
            }
        )

    return predictions


def main() -> None:
    parser = argparse.ArgumentParser(description="Run XGB weather forecast from stdin rows.")
    parser.add_argument("--model", required=True, help="Path to xgb_3models_robust.joblib")
    parser.add_argument("--mode", choices=["hourly", "weekly"], default="hourly")
    args = parser.parse_args()

    model_path = Path(args.model).expanduser().resolve()
    if not model_path.exists():
        _fail(f"Model file not found: {model_path}")

    payload = _load_stdin_payload()
    rows = payload.get("rows", [])
    now_ts = _parse_now(payload.get("now"))

    if not isinstance(rows, list):
        _fail("Input field 'rows' must be an array.")

    try:
        models = joblib.load(model_path)
    except Exception as exc:  # noqa: BLE001
        _fail(f"Failed to load model: {exc}")

    if not isinstance(models, dict):
        _fail("Model payload must be a dict with temp/humi/pres regressors.")

    for key in ("temp", "humi", "pres"):
        if key not in models:
            _fail(f"Model payload missing '{key}' regressor.")

    history_df = _build_hourly_history(rows)

    feature_columns = DEFAULT_FEATURE_COLUMNS
    temp_model = models.get("temp")
    inferred_features = getattr(temp_model, "feature_names_in_", None)
    if inferred_features is not None:
        feature_columns = [str(name) for name in inferred_features]

    predictions = _forecast(models, history_df, args.mode, now_ts, feature_columns)
    json.dump({"predictions": predictions}, sys.stdout)


if __name__ == "__main__":
    main()
