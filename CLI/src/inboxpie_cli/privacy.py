from __future__ import annotations

import re


def mask_email(email: str) -> str:
    if not email or "@" not in email:
        return email or ""
    local, domain = email.split("@", 1)
    masked_local = local if len(local) <= 1 else f"{local[0]}***"
    return f"{masked_local}@{mask_domain(domain)}"


def mask_domain(domain: str) -> str:
    domain = (domain or "").strip()
    if not domain or domain == "unknown":
        return domain
    parts = domain.split(".")
    if len(parts) < 2:
        return f"{domain[0]}***"
    tld = parts[-1]
    base = ".".join(parts[:-1])
    return f"{base[0]}***.{tld}" if base else f"***.{tld}"


def mask_text(text: str, enabled: bool) -> str:
    if not enabled or not text:
        return text
    if re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", text):
        return mask_email(text)
    if re.match(r"^[a-z0-9.-]+\.[a-z]{2,}$", text, re.I):
        return mask_domain(text)
    return text
