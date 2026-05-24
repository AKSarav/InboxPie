from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(slots=True)
class MessageRecord:
    """Schema kept compatible with Thunderbird extractMessageData."""

    id: str | int
    subject: str
    author: str
    senderName: str
    senderEmail: str
    domain: str
    date: str
    year: int
    month: int
    monthName: str
    read: bool
    flagged: bool
    folder: str
    folderType: str
    account: str
    accountId: str
    tags: list[str] = field(default_factory=list)
    size: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
