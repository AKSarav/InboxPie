import sqlite3
from pathlib import Path

from inboxpie_cli.sources.envelope_index import scan_envelope_index


def _create_fixture_db(db_path: Path) -> None:
    conn = sqlite3.connect(db_path)
    conn.executescript(
        """
        CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject TEXT NOT NULL);
        CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY, address TEXT NOT NULL, comment TEXT NOT NULL);
        CREATE TABLE mailboxes (
            ROWID INTEGER PRIMARY KEY,
            url TEXT NOT NULL,
            total_count INTEGER NOT NULL DEFAULT 0,
            unread_count INTEGER NOT NULL DEFAULT 0,
            deleted_count INTEGER NOT NULL DEFAULT 0,
            unseen_count INTEGER NOT NULL DEFAULT 0,
            unread_count_adjusted_for_duplicates INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE messages (
            ROWID INTEGER PRIMARY KEY,
            message_id INTEGER NOT NULL,
            global_message_id INTEGER NOT NULL DEFAULT 0,
            sender INTEGER,
            subject INTEGER NOT NULL,
            date_sent INTEGER,
            date_received INTEGER,
            mailbox INTEGER NOT NULL,
            flags INTEGER NOT NULL DEFAULT 0,
            read INTEGER NOT NULL DEFAULT 0,
            flagged INTEGER NOT NULL DEFAULT 0,
            deleted INTEGER NOT NULL DEFAULT 0,
            size INTEGER NOT NULL DEFAULT 0,
            conversation_id INTEGER NOT NULL DEFAULT 0,
            is_urgent INTEGER NOT NULL DEFAULT 0
        );

        INSERT INTO subjects (ROWID, subject) VALUES (1, 'Hello World');
        INSERT INTO addresses (ROWID, address, comment) VALUES (1, 'john@example.com', 'John Doe');
        INSERT INTO mailboxes (ROWID, url) VALUES (1, 'imap://user@mail.example.com/INBOX');
        INSERT INTO messages (
            ROWID, message_id, global_message_id, sender, subject,
            date_sent, date_received, mailbox, read, flagged, deleted, size, conversation_id, is_urgent
        ) VALUES (1, 1001, 1001, 1, 1, 100000, 100000, 1, 0, 1, 0, 2048, 1, 0);
        """
    )
    conn.commit()
    conn.close()


def test_scan_envelope_index_reads_joined_schema(tmp_path: Path) -> None:
    mail_root = tmp_path / "Mail" / "V10" / "MailData"
    mail_root.mkdir(parents=True)
    _create_fixture_db(mail_root / "Envelope Index")

    records = scan_envelope_index(tmp_path / "Mail", folders=set())

    assert len(records) == 1
    record = records[0]
    assert record.subject == "Hello World"
    assert record.senderEmail == "john@example.com"
    assert record.senderName == "John Doe"
    assert record.folder == "INBOX"
    assert record.read is False
    assert record.flagged is True
    assert record.size == 2048


def test_scan_envelope_index_folder_filter(tmp_path: Path) -> None:
    mail_root = tmp_path / "Mail" / "V10" / "MailData"
    mail_root.mkdir(parents=True)
    _create_fixture_db(mail_root / "Envelope Index")

    records = scan_envelope_index(tmp_path / "Mail", folders={"Sent"})
    assert records == []

    records = scan_envelope_index(tmp_path / "Mail", folders={"INBOX"})
    assert len(records) == 1
