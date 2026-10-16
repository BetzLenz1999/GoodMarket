"""Reloadly operator product classification and normalization.

Reloadly returns every service type (airtime, mobile data, bundles) for a
country in one payload, and data/bundle plans are separate *operators* with
their own ``operatorId`` (e.g. "TM" and "TM Bundles"). Nothing upstream labels
which is which, so the store used to show one mixed grid and only revealed the
plan descriptions ("5GB, 30 days") for whichever operator happened to expose
them.

This module is intentionally dependency-free (stdlib only) so it imports and
tests without flask/requests. It answers two questions:

* ``classify_operator`` — is this operator airtime, mobile data or a bundle?
* ``normalize_operator_products`` — turn a per-operator product payload into a
  stable, UI-friendly shape (airtime amounts and bundle plans with their
  descriptions) so the frontend never has to guess at Reloadly's field names.

The classification is derived ONLY from the flags/flags-in-name Reloadly sends,
never from a per-country table, so it works for every country.
"""

from typing import Any, Dict, List, Optional

# Product buckets used by the store's filter chips.
FILTER_ALL = "all"
FILTER_AIRTIME = "airtime"
FILTER_DATA = "data"

# Order matters: the chips render in this order and "data" deliberately lumps
# mobile data + bundles + combo together (they are all "buy a plan, not
# credit" from the user's point of view).
PRODUCT_FILTERS = (FILTER_ALL, FILTER_AIRTIME, FILTER_DATA)

# Human labels for the operator-card badge.
PRODUCT_TYPE_LABELS = {
    "airtime": "Airtime",
    "data": "Data",
    "bundle": "Data bundle",
    "combo": "Airtime + data",
}

# Keyword hints for the times Reloadly omits the flags (older API revisions).
# Matched case-insensitively against the operator name; a keyword hit only
# re-classifies an operator that is *not* already flagged as airtime-only.
_DATA_KEYWORDS = ("bundle", "bundles", "data", "internet", "gb ", " mb")
_COMBO_KEYWORDS = ("combo", "voice + data", "voice+data", "voice and data")


def _truthy(value: Any) -> bool:
    """Reloadly serializes boolean flags as ``0``/``1``, ``true`` or ``null``."""
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() in ("1", "true", "yes")


def classify_operator(operator: Optional[Dict[str, Any]]) -> str:
    """Return ``airtime`` | ``data`` | ``bundle`` | ``combo`` for an operator.

    ``combo`` (hybrid voice + data) is checked first because those packages
    include airtime too, then ``data``/``bundle`` flags, then a couple of
    conservative name keywords as a fallback. Everything else is airtime.
    """
    if not operator:
        return "airtime"

    if _truthy(operator.get("combo")) or _truthy(operator.get("comboData")):
        return "combo"

    if _truthy(operator.get("data")):
        return "data"
    if _truthy(operator.get("bundle")):
        return "bundle"

    name = str(operator.get("name") or "").lower()
    if name:
        if any(kw in name for kw in _COMBO_KEYWORDS):
            return "combo"
        if any(kw in name for kw in _DATA_KEYWORDS):
            return "data"

    return "airtime"


def is_data_product(product_type: str) -> bool:
    """True when the bucket should be shown under the "Data & Bundles" chip."""
    return product_type in ("data", "bundle", "combo")


def operator_flag_products(operators: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """Attach ``product_type`` / ``is_data_bundle`` to each operator (additive)."""
    out = []
    for op in operators or []:
        if not isinstance(op, dict):
            continue
        enriched = dict(op)
        ptype = classify_operator(op)
        enriched["product_type"] = ptype
        enriched["is_data_bundle"] = is_data_product(ptype)
        out.append(enriched)
    return out


def _to_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _desc_for(descriptions: Dict[str, Any], key: Any) -> str:
    """Look a description up tolerating Reloadly's float-string key formats."""
    if not isinstance(descriptions, dict):
        return ""
    variants = []
    as_float = _to_float(key)
    if as_float is not None:
        variants.extend([
            f"{as_float:.2f}",
            str(as_float),
            f"{as_float:.1f}",
        ])
    variants.append(str(key))
    for candidate in variants:
        if candidate in descriptions and descriptions[candidate]:
            return str(descriptions[candidate]).strip()
    return ""


def normalize_operator_products(payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Normalize a per-operator product payload for the store UI.

    Returns a shape with ``fixed`` (one entry per purchasable amount, with its
    plan description when Reloadly supplies one), ``suggested`` amounts and the
    operator's range/denomination metadata. Missing fields degrade gracefully so
    a sparse payload still renders (amounts only).
    """
    payload = payload or {}
    product_type = classify_operator(payload)

    fixed_amounts = payload.get("fixedAmounts") or []
    local_fixed = payload.get("localFixedAmounts") or []
    usd_descs = payload.get("fixedAmountsDescriptions") or {}
    local_descs = payload.get("localFixedAmountsDescriptions") or {}

    fixed: List[Dict[str, Any]] = []
    for idx, usd in enumerate(fixed_amounts):
        usd_f = _to_float(usd)
        local = local_fixed[idx] if idx < len(local_fixed) else None
        desc = _desc_for(usd_descs, usd) or _desc_for(local_descs, local)
        fixed.append({
            "usd": usd_f,
            "local": _to_float(local),
            "description": desc,
        })

    # De-duplicate: some operators repeat an amount across usd/local maps.
    seen = set()
    deduped = []
    for entry in fixed:
        key = (entry["usd"], entry["description"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(entry)

    suggested = [_to_float(a) for a in (payload.get("suggestedAmounts") or [])]
    suggested = [s for s in suggested if s is not None]

    return {
        "operator_id": payload.get("operatorId") or payload.get("id"),
        "name": payload.get("name") or "",
        "product_type": product_type,
        "is_data_bundle": is_data_product(product_type),
        "denomination_type": (payload.get("denominationType") or "").upper(),
        "has_fixed": bool(deduped),
        "has_range": _to_float(payload.get("minAmount")) is not None
                     and _to_float(payload.get("maxAmount")) is not None,
        "min_amount": _to_float(payload.get("minAmount")),
        "max_amount": _to_float(payload.get("maxAmount")),
        "local_min_amount": _to_float(payload.get("localMinAmount")),
        "local_max_amount": _to_float(payload.get("localMaxAmount")),
        "destination_currency_code": payload.get("destinationCurrencyCode") or "USD",
        "destination_currency_symbol": payload.get("destinationCurrencySymbol") or "$",
        "fixed": deduped,
        "suggested": suggested,
    }
