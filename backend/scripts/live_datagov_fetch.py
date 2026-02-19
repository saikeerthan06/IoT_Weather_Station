#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


API_BASE = "https://api-open.data.gov.sg/v2/real-time/api"
DEFAULT_HEADERS = {
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    # Cloudflare/WAF can block default Python user agents with 403.
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/121.0.0.0 Safari/537.36"
    ),
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}


def _fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def _parse_timeout_seconds() -> float:
    raw = os.getenv("DATAGOV_TIMEOUT_SECONDS", "8").strip()
    try:
        value = float(raw)
    except ValueError:
        return 8.0

    if value <= 0:
        return 8.0

    return min(value, 30.0)


def _to_float(raw: Any) -> Optional[float]:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None

    if value != value:
        return None

    return value


def _to_iso_timestamp(raw: Any) -> Optional[str]:
    if not isinstance(raw, str) or not raw.strip():
        return None

    text = raw.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)

    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _error_body_snippet(exc: HTTPError) -> str:
    try:
        raw = exc.read().decode("utf-8", errors="ignore").strip()
    except Exception:
        return ""

    if not raw:
        return ""

    return raw.replace("\n", " ")[:180]


def _headers_for(api_key: Optional[str]) -> Dict[str, str]:
    headers = dict(DEFAULT_HEADERS)
    if api_key:
        headers["X-Api-Key"] = api_key
    return headers


def _attempt_fetch(path: str, headers: Dict[str, str], timeout: float) -> Dict[str, Any]:
    request = Request(f"{API_BASE}/{path}", headers=headers)
    with urlopen(request, timeout=timeout) as response:
        raw_payload = response.read().decode("utf-8")

    try:
        payload = json.loads(raw_payload)
    except json.JSONDecodeError as exc:
        _fail(f"{path} API returned invalid JSON: {exc}")

    if not isinstance(payload, dict):
        _fail(f"{path} API payload must be a JSON object.")

    data = payload.get("data")
    if not isinstance(data, dict):
        _fail(f"{path} API payload missing data object.")

    return data


def _fetch_endpoint(path: str, api_key: str, timeout: float) -> Dict[str, Any]:
    auth_modes: List[Tuple[str, Optional[str]]]
    if api_key:
        auth_modes = [("with API key", api_key), ("without API key", None)]
    else:
        auth_modes = [("without API key", None)]

    errors: List[str] = []

    for mode_label, maybe_key in auth_modes:
        headers = _headers_for(maybe_key)
        try:
            return _attempt_fetch(path, headers, timeout)
        except HTTPError as exc:
            snippet = _error_body_snippet(exc)
            detail = f"{mode_label}: status {exc.code}"
            if snippet:
                detail += f" ({snippet})"
            errors.append(detail)
        except URLError as exc:
            errors.append(f"{mode_label}: {exc.reason}")
        except TimeoutError:
            errors.append(f"{mode_label}: timed out")

    _fail(f"{path} API request failed. {'; '.join(errors)}")


def _extract_series(data: Dict[str, Any], preferred_station: str) -> List[Dict[str, Any]]:
    readings = data.get("readings")
    if not isinstance(readings, list):
        return []

    series: List[Dict[str, Any]] = []

    for reading in readings:
        if not isinstance(reading, dict):
            continue

        timestamp = _to_iso_timestamp(reading.get("timestamp"))
        if timestamp is None:
            continue

        station_values = reading.get("data")
        if not isinstance(station_values, list):
            continue

        selected: Optional[Tuple[Optional[str], float]] = None
        for entry in station_values:
            if not isinstance(entry, dict):
                continue

            station_id_raw = entry.get("stationId")
            station_id = str(station_id_raw) if station_id_raw is not None else None
            value = _to_float(entry.get("value"))
            if value is None:
                continue

            if selected is None:
                selected = (station_id, value)

            if preferred_station and station_id == preferred_station:
                selected = (preferred_station, value)
                break

        if selected is None:
            continue

        station_id, value = selected
        series.append({"time": timestamp, "value": value, "stationId": station_id})

    series.sort(key=lambda item: item["time"])
    return series


def _latest_entry(series: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not series:
        return {"timestamp": None, "value": None, "stationId": None}

    latest = series[-1]
    return {
        "timestamp": latest.get("time"),
        "value": latest.get("value"),
        "stationId": latest.get("stationId"),
    }


def main() -> None:
    station_id = os.getenv("DATAGOV_STATION_ID", "S109").strip() or "S109"
    timeout = _parse_timeout_seconds()
    api_key = os.getenv("DATAGOV_API_KEY", "").strip()

    rainfall_payload = _fetch_endpoint("rainfall", api_key, timeout)
    windspeed_payload = _fetch_endpoint("wind-speed", api_key, timeout)
    winddirection_payload = _fetch_endpoint("wind-direction", api_key, timeout)

    rainfall_series = _extract_series(rainfall_payload, station_id)
    windspeed_series = _extract_series(windspeed_payload, station_id)
    winddirection_series = _extract_series(winddirection_payload, station_id)

    rainfall_latest = _latest_entry(rainfall_series)
    windspeed_latest = _latest_entry(windspeed_series)
    winddirection_latest = _latest_entry(winddirection_series)

    resolved_station = (
        rainfall_latest.get("stationId")
        or windspeed_latest.get("stationId")
        or winddirection_latest.get("stationId")
        or station_id
    )

    output = {
        "stationId": resolved_station,
        "requestedStationId": station_id,
        "fetchedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "rainfall": {
            "timestamp": rainfall_latest.get("timestamp"),
            "value": rainfall_latest.get("value"),
            "unit": "mm",
            "stationId": rainfall_latest.get("stationId"),
        },
        "rainfallSeries": [
            {"time": point["time"], "value": point["value"]}
            for point in rainfall_series
            if isinstance(point, dict)
        ],
        "windspeed": {
            "timestamp": windspeed_latest.get("timestamp"),
            "value": windspeed_latest.get("value"),
            "unit": "knots",
            "stationId": windspeed_latest.get("stationId"),
        },
        "winddirection": {
            "timestamp": winddirection_latest.get("timestamp"),
            "value": winddirection_latest.get("value"),
            "unit": "degrees",
            "stationId": winddirection_latest.get("stationId"),
        },
    }

    json.dump(output, sys.stdout)


if __name__ == "__main__":
    main()
