"""Run a consumer AI assistant on a Commerce Bench task, reported track.

Reads one task JSON on stdin and prints one result JSON as the last stdout line.

  python3 examples/assistant-bridge.py --assistant manus --channel manus < task.json
  python3 examples/assistant-bridge.py --assistant demo --channel none --reply-file reply.txt < task.json

Live channels come from an external checkout located by ABENCH_DIR.
"""
import sys

sys.dont_write_bytecode = True

import argparse
import contextlib
import http.client
import ipaddress
import json
import os
import re
import socket
import ssl
import threading
import time
import urllib.parse

REAL_STDOUT = sys.stdout
STAGES = ["product", "cart", "checkout", "shipping", "payment"]
STAGE_WORDS = STAGES + ["none"]
DEADLINE_MARGIN_S = 60
MIN_BUDGET_S = 30
JOIN_GRACE_S = 5
MAX_IMAGES = 5
MAX_IMAGE_BYTES = 10 * 1024 * 1024
IMAGE_TIMEOUT_S = 20
DOWNLOAD_BUDGET_S = 60
MAX_REDIRECTS = 3
MIN_WIDTH = 600
MIN_HEIGHT = 400
MESSAGE_CAP = 200

CHANNEL_ENV = {
    "cursor": [["ABENCH_CURSOR_TOKEN"]],
    "manus": [["MANUS_API_KEY"]],
    "email": [["ABENCH_EMAIL_USER"], ["ABENCH_EMAIL_PASS"], ["ABENCH_SMTP_HOST"], ["ABENCH_IMAP_HOST"]],
    "openclaw": [["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]],
}
SECRET_ENV = [
    "ABENCH_BASE", "ABENCH_CURSOR_WEBHOOK", "ABENCH_CURSOR_TOKEN", "ABENCH_IMESSAGE_TO",
    "ABENCH_IMESSAGE_NAME", "ABENCH_EMAIL_USER", "ABENCH_EMAIL_PASS", "ABENCH_SMTP_HOST",
    "ABENCH_IMAP_HOST", "ABENCH_WEBHOOK_URL", "ABENCH_WEBHOOK_POLL", "ABENCH_HERMES_URL",
    "ABENCH_HERMES_KEY", "ABENCH_HERMES_BIN", "ABENCH_OPENCLAW_BIN", "MANUS_API_KEY",
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY",
]
BROWSER_PROFILE = os.path.expanduser("~/.abench/browser-profile")

STOP_TEXT = {
    "product": "Stop as soon as the product page is open.",
    "cart": "Stop as soon as the cart holds the item.",
    "checkout": "Stop as soon as the guest checkout form is open.",
    "shipping": "Stop as soon as the site accepts the contact and shipping details. Do not go further.",
    "payment": "Stop as soon as the payment step is shown. Leave every payment field empty.",
}
STAGE_MEANING = {
    "product": "the product page was open",
    "cart": "the cart held the item",
    "checkout": "the guest checkout form was open",
    "shipping": "the site accepted the shipping details",
    "payment": "the payment step was shown",
}

CLAUSE_BREAK = re.compile(r"[.!?;:,](?=\s|$)|\n|\(")
FILLER = {
    "i", "we", "you", "i've", "we've", "you've", "i'd", "we'd", "i'm", "we're", "i'll", "we'll",
    "have", "had", "has", "did", "do", "does", "was", "were", "is", "be", "been", "ever", "even",
    "yet", "actually", "then", "already", "successfully", "just", "also", "the", "a", "an",
    "your", "my", "our", "any", "really", "finally",
}
NEGATORS = {"not", "never", "no", "without", "before", "nor", "cannot", "neither", "avoid", "avoided", "refused", "instead"}
PAYMENT_ACTIVE = [
    re.compile(r"\b(?:placed|submitted|completed|confirmed|finali[sz]ed|finished)\s+(?:the\s+|an?\s+|your\s+|my\s+|this\s+)?(?:order|purchase|payment|checkout|transaction)\b", re.I),
    re.compile(r"\b(?:paid|purchased|bought)\b", re.I),
    re.compile(r"\b(?:entered|typed|filled\s+in|input|inputted|added|provided|submitted|used|saved|selected|chose|applied)\s+(?:(?:the|a|an|my|your|test|saved|stored|existing|new)\s+)*(?:credit\s+|debit\s+)?(?:card|card\s+number|card\s+details|payment\s+(?:details|info|information|method)|cvv|cvc|visa|mastercard|amex|american\s+express)\b", re.I),
    re.compile(r"\bchecked\s+out\s+(?:with|using)\b", re.I),
    re.compile(r"\b(?:clicked|pressed|hit|tapped|selected|chose)\s+(?:on\s+)?(?:the\s+)?[\"'“]?(?:place|submit|complete|confirm)\s+(?:my\s+|your\s+)?(?:order|purchase|payment)\b", re.I),
    re.compile(r"\b(?:clicked|pressed|hit|tapped)\s+(?:on\s+)?(?:the\s+)?[\"'“]?(?:pay|buy)\s+now\b", re.I),
]
PAYMENT_PASSIVE = re.compile(
    r"\b(?:order|purchase|payment|card|card\s+details|card\s+number|transaction)"
    r"(?:\s+(?:#\s*)?(?=[A-Z0-9-]*\d)[A-Z0-9-]+)?"
    r"\s+(?:has\s+been\s+|have\s+been\s+|was\s+|were\s+|is\s+|got\s+|been\s+)?(not\s+)?"
    r"(?:placed|confirmed|submitted|completed?|successful|processed|accepted|charged|entered|received)\b",
    re.I,
)
ORDER_CODE = re.compile(r"\b(?:order|confirmation)\s*(?:number|no\.?|id|code|#)\s*(?:is\s*)?[:#]?\s*(?=[A-Z0-9-]*\d)[A-Z0-9-]{5,}", re.I)
CARD_DIGITS = re.compile(r"(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)")
REFUSALS = re.compile(
    r"\b(?:i\s+(?:can(?:'|no)t|cannot|am\s+not\s+able\s+to|'m\s+not\s+able\s+to|won't|will\s+not|am\s+unable\s+to|'m\s+unable\s+to)\s+(?:help|assist|do\s+that|make\s+purchases|complete\s+purchases|shop|buy|browse))",
    re.I,
)
CONTRADICTIONS = re.compile(
    r"\b(?:could\s*n[o']t|couldn't|unable\s+to|was\s*n[o']t\s+able|wasn't\s+able|failed\s+to|not\s+accepted|rejected|blocked|did\s+not\s+reach|didn't\s+reach|did\s+not\s+get\s+to|didn't\s+get\s+to)\b",
    re.I,
)
BOT_VENDORS = [
    ("cloudflare", r"cloudflare|turnstile|just a moment"),
    ("datadome", r"datadome"),
    ("perimeterx", r"perimeter\s*x|press\s*(?:&|and)\s*hold|human security"),
    ("akamai", r"akamai"),
    ("imperva", r"imperva|incapsula"),
    ("kasada", r"kasada"),
]
FAILURE_RULES = [
    ("bot", re.compile(r"\bbot\b|bot[- ]detect|access\s+denied|unusual\s+traffic|automated\s+(?:traffic|access|browsing)|blocked\s+(?:me|access|by)|press\s*(?:&|and)\s*hold|cloudflare|datadome|perimeter\s*x|akamai|imperva|incapsula|kasada|turnstile", re.I)),
    ("captcha_required", re.compile(r"captcha|verify\s+(?:that\s+)?you(?:'re|\s+are)\s+(?:a\s+)?human|are\s+you\s+a\s+robot", re.I)),
    ("login_required", re.compile(r"\bsign[\s-]?in\b|\blog[\s-]?in\b|create\s+an\s+account|account\s+(?:is\s+)?required|requires?\s+an\s+account|no\s+guest\s+checkout|guest\s+checkout\s+(?:is\s+)?not\s+(?:available|offered)", re.I)),
    ("delivery_not_available", re.compile(r"(?:does\s*n[o']t|doesn't|cannot|can't|won't|will\s+not|do\s+not|don't)\s+(?:deliver|ship)|no\s+delivery|not\s+available\s+for\s+delivery|delivery\s+(?:is\s+)?(?:not\s+available|unavailable)", re.I)),
    ("customer_details_rejected", re.compile(r"(?:address|post(?:al)?\s*code|zip|phone|email|details)\s+(?:was\s+|were\s+|is\s+)?(?:rejected|not\s+accepted|invalid|refused)|invalid\s+(?:address|post(?:al)?\s*code|zip|phone|email)", re.I)),
    ("add_to_cart_failed", re.compile(r"(?:could\s*n[o']t|couldn't|unable\s+to|failed\s+to|cannot|can't)\s+add\b\s*(?:it|the\s+(?:item|product))?\s*(?:to\s+(?:the\s+)?(?:cart|bag|basket|trolley))?|add\s+to\s+(?:cart|bag|basket)\s+(?:button\s+)?(?:failed|did\s*n[o']t\s+work|didn't\s+work|was\s+disabled)", re.I)),
    ("product_not_available", re.compile(r"out\s+of\s+stock|sold\s+out|no\s+longer\s+(?:available|sold)|discontinued|(?:product|item|variant|size|colou?r)\s+(?:is\s+|was\s+)?(?:not\s+available|unavailable)|could\s*n[o']t\s+find\s+the\s+(?:product|item)|couldn't\s+find\s+the\s+(?:product|item)", re.I)),
    ("website_unavailable", re.compile(r"site\s+(?:is\s+|was\s+)?(?:down|unavailable)|server\s+error|\b50[0234]\b|(?:page|site)\s+(?:would\s*n[o']t|wouldn't|did\s*n[o']t|didn't|could\s*n[o']t|couldn't)\s+load|could\s*n[o']t\s+load|couldn't\s+load", re.I)),
    ("timeout", re.compile(r"timed\s+out|ran\s+out\s+of\s+time|time\s+limit", re.I)),
]
CURRENCY_SYMBOLS = {"$": "USD", "£": "GBP", "€": "EUR"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
IMAGE_TYPES = {"image/png", "image/jpeg", "image/jpg", "image/webp"}
BLOCKED_NETS = [ipaddress.ip_network("64:ff9b::/96"), ipaddress.ip_network("2002::/16"), ipaddress.ip_network("64:ff9b:1::/48")]


class SetupError(Exception):
    pass


class Redactor:
    def __init__(self):
        self.values = set()

    def add(self, value):
        if value and len(value) >= 4:
            self.values.add(value)

    def __call__(self, text):
        text = str(text)
        for value in sorted(self.values, key=len, reverse=True):
            text = text.replace(value, "[redacted]")
        return text


REDACT = Redactor()


class RedactingStream:
    def __init__(self, target):
        self.target = target

    def write(self, text):
        return self.target.write(REDACT(text))

    def flush(self):
        self.target.flush()


def log(message):
    line = " ".join(REDACT(message).split())
    sys.__stderr__.write(line + "\n")
    sys.__stderr__.flush()


def emit(result):
    REAL_STDOUT.write(json.dumps(result) + "\n")
    REAL_STDOUT.flush()


def resolve_value(raw, label):
    if raw is None:
        return None
    if raw.startswith("env:"):
        name = raw[4:]
        value = os.environ.get(name, "")
        if not value:
            raise SetupError(f"{label} needs environment variable {name}, which is not set")
        REDACT.add(value)
        return value
    REDACT.add(raw)
    return raw


def stage_options(stop_at):
    return "|".join(STAGES[:STAGES.index(stop_at) + 1] + ["none"])


def build_prompt(task, stop_at):
    product = task.get("product") or {}
    shopper = task.get("shopper") or {}
    address = shopper.get("address") or {}
    item = product.get("name", "")
    if product.get("variant"):
        item += f" ({product['variant']})"
    item += f", quantity {product.get('quantity', 1)}"
    address_lines = [address.get("line1"), address.get("line2"), address.get("city"), address.get("state"), address.get("postal_code"), address.get("country")]
    rules = "\n".join(f"- {rule}" for rule in task.get("rules") or [])
    return "\n".join([
        "Please do this shopping task in your own browser. This is a test run for a public benchmark. Nobody will answer questions while you work, so pick the most reasonable option and keep going.",
        "",
        f"Start here: {task.get('start_url', '')}",
        f"Task: {task.get('goal', '')}",
        f"Product: {item}",
        "",
        "Use these shopper details exactly as given. They are placeholders for testing:",
        f"- Name: {shopper.get('first_name', '')} {shopper.get('last_name', '')}",
        f"- Email: {shopper.get('email', '')}",
        f"- Phone: {shopper.get('phone', '')}",
        f"- Address: {', '.join(part for part in address_lines if part)}",
        "",
        "Rules:",
        rules,
        f"- {STOP_TEXT[stop_at]}",
        "- Never enter a card number or any payment details.",
        "- Never place an order, and never press a button that pays or places an order.",
        "- Never save a payment method, and do not use one that is already saved.",
        "- Take a screenshot of the final page and attach it to your reply, or include a direct https link to the image.",
        "",
        "When you stop, end your reply with exactly these four lines, filled in:",
        f"STAGE: {stage_options(stop_at)}",
        "TOTAL: <order total with currency, or unknown>",
        "URL: <the URL of the last page you were on>",
        "STOPPED: <why you stopped, in one sentence>",
        "",
        f"Pick one STAGE word: the furthest step you actually reached. Use {stop_at} only if {STAGE_MEANING[stop_at]}.",
    ])


FIELD_LINE = re.compile(r"^[\s*_`>#-]*(STAGE|TOTAL|URL|STOPPED)[*_`\s]*:[*_`\s]*(.*?)[*_`\s]*$", re.I)


def final_block(reply, stop_at):
    fields = {}
    stages = []
    payment_stage = False
    template = stage_options(stop_at)
    for raw in reply.splitlines():
        match = FIELD_LINE.match(raw)
        if not match:
            continue
        key, value = match.group(1).upper(), match.group(2).strip()
        if key == "STAGE" and value.replace(" ", "") != template and re.search(r"\bpayment\b", value, re.I):
            payment_stage = True
        if "|" in value or value.startswith("<"):
            continue
        fields[key] = value
        if key == "STAGE":
            stages.append(value)
    return fields, stages, payment_stage


def stage_word(value):
    if value is None:
        return None
    word = value.strip().strip(".!").lower()
    return word if word in STAGE_WORDS else None


def governed(text, start):
    prefix = text[:start]
    breaks = [match.end() for match in CLAUSE_BREAK.finditer(prefix)]
    clause = prefix[breaks[-1]:] if breaks else prefix
    for token in reversed(re.findall(r"[a-z']+", clause.lower())):
        if token in NEGATORS or token.endswith("n't"):
            return True
        if token in FILLER:
            continue
        return False
    return False


def luhn(digits):
    total = 0
    for index, char in enumerate(reversed(digits)):
        value = int(char)
        if index % 2 == 1:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return total % 10 == 0


def claims_payment(text):
    for pattern in PAYMENT_ACTIVE:
        for match in pattern.finditer(text):
            if not governed(text, match.start()):
                return True
    for match in PAYMENT_PASSIVE.finditer(text):
        if not match.group(1) and not governed(text, match.start()):
            return True
    for match in ORDER_CODE.finditer(text):
        if not governed(text, match.start()):
            return True
    for match in CARD_DIGITS.finditer(re.sub(r"\S*://\S+", " ", text)):
        digits = re.sub(r"\D", "", match.group(0))
        if 13 <= len(digits) <= 19 and luhn(digits):
            return True
    return False


def failure_code(text):
    if not text:
        return ""
    for code, pattern in FAILURE_RULES:
        if all(governed(text, match.start()) for match in pattern.finditer(text)):
            continue
        if code == "bot":
            for vendor, vendor_pattern in BOT_VENDORS:
                if re.search(vendor_pattern, text, re.I):
                    return f"bot_detected:{vendor}"
            return "bot_detected:unknown"
        return code
    return ""


def parse_total(value):
    if not value or re.search(r"unknown|n/a|not shown|none", value, re.I):
        return None
    match = re.search(r"([$£€])?\s*(\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*([A-Z]{3})?", value)
    if not match:
        return None
    amount = float(re.sub(r"[,\s]", "", match.group(2)))
    code = re.search(r"\b([A-Z]{3})\b", value)
    currency = code.group(1) if code else CURRENCY_SYMBOLS.get(match.group(1) or "")
    return {"amount": amount, "currency": currency}


def capped(text):
    return REDACT(" ".join((text or "").split()))[:MESSAGE_CAP]


def interpret(reply, stop_at):
    text = reply.replace("’", "'").replace("‘", "'").strip()
    if not text:
        return {"status": "failed", "failure": {"code": "timeout", "message": "the assistant sent no reply before the deadline"}}
    fields, stages, payment_stage = final_block(text, stop_at)
    stopped = fields.get("STOPPED", "")
    result = {}
    total = parse_total(fields.get("TOTAL"))
    if total:
        result["reported_total"] = total
    url = fields.get("URL", "").strip("<> ")
    if re.match(r"^https?://\S+$", url):
        result["final_url"] = REDACT(url)[:2000]

    if payment_stage or claims_payment(text):
        result.update(status="completed", claimed_stage="payment", failure={"code": "", "message": capped(stopped or "the reply says a card was entered, payment was made, or an order was placed")})
        return result

    if REFUSALS.search(text) and not stages:
        result.update(status="failed", failure={"code": "", "message": capped(text)})
        return result

    distinct = {stage_word(value) for value in stages}
    stage = stage_word(fields.get("STAGE")) if len(distinct) == 1 else None
    code = failure_code(stopped) if stopped else failure_code(text)

    if stage is None:
        message = stopped or ("the reply had no clear STAGE line" if not stages else "the reply gave an unclear or conflicting STAGE")
        result.update(status="failed", failure={"code": code, "message": capped(message)})
        return result

    if stage == stop_at:
        contradicted = bool(code) or bool(CONTRADICTIONS.search(stopped)) or bool(REFUSALS.search(text))
        if not contradicted:
            result.update(status="completed", claimed_stage=stage)
            return result
        result.update(status="failed", failure={"code": code, "message": capped(stopped or "the reply claimed the stop stage and also described a problem")})
        return result

    if stage != "none" and STAGES.index(stage) > STAGES.index(stop_at):
        result.update(status="completed", claimed_stage=stage, failure={"code": "", "message": capped(stopped)})
        return result

    if stage != "none":
        result["claimed_stage"] = stage
    result.update(status="failed", failure={"code": code, "message": capped(stopped or f"stopped at {stage}")})
    return result


def public_address(value):
    address = ipaddress.ip_address(value.split("%")[0])
    if getattr(address, "ipv4_mapped", None):
        address = address.ipv4_mapped
    if not address.is_global or address.is_multicast:
        return False
    return not any(address in net for net in BLOCKED_NETS if net.version == address.version)


def checked_target(url):
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        raise ValueError("not a plain https link")
    port = parts.port or 443
    if port != 443:
        raise ValueError("not port 443")
    host = parts.hostname.lower().rstrip(".")
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise ValueError("local host name")
    infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    addresses = [info[4][0] for info in infos]
    if not addresses or not all(public_address(address) for address in addresses):
        raise ValueError("not a public address")
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    return host, addresses[0], path


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, address, timeout):
        super().__init__(host, 443, timeout=timeout, context=ssl.create_default_context())
        self.pinned_address = address

    def connect(self):
        sock = socket.create_connection((self.pinned_address, 443), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def on_site(host, site):
    site = (site or "").lower().split(":")[0]
    if site.startswith("www."):
        site = site[4:]
    return bool(site) and (host == site or host.endswith("." + site))


def image_size(body):
    if body.startswith(b"\x89PNG\r\n\x1a\n") and len(body) >= 24 and body[12:16] == b"IHDR":
        return "png", int.from_bytes(body[16:20], "big"), int.from_bytes(body[20:24], "big")
    if body.startswith(b"\xff\xd8\xff"):
        index = 2
        while index + 9 < len(body):
            if body[index] != 0xFF:
                index += 1
                continue
            marker = body[index + 1]
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7 or marker == 0xFF:
                index += 1 if marker == 0xFF else 2
                continue
            length = int.from_bytes(body[index + 2:index + 4], "big")
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                return "jpg", int.from_bytes(body[index + 7:index + 9], "big"), int.from_bytes(body[index + 5:index + 7], "big")
            index += 2 + length
        return "jpg", 0, 0
    if len(body) >= 30 and body[:4] == b"RIFF" and body[8:12] == b"WEBP":
        chunk = body[12:16]
        if chunk == b"VP8 " and body[23:26] == b"\x9d\x01\x2a":
            return "webp", int.from_bytes(body[26:28], "little") & 0x3FFF, int.from_bytes(body[28:30], "little") & 0x3FFF
        if chunk == b"VP8L" and body[20] == 0x2F:
            bits = int.from_bytes(body[21:25], "little")
            return "webp", (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
        if chunk == b"VP8X":
            return "webp", int.from_bytes(body[24:27], "little") + 1, int.from_bytes(body[27:30], "little") + 1
        return "webp", 0, 0
    return None, 0, 0


def image_links(reply):
    found = []
    for match in re.finditer(r"!\[[^\]]*\]\((https://[^)\s]+)\)", reply):
        found.append(match.group(1))
    for match in re.finditer(r"https://[^\s<>()\"'\]]+", reply):
        url = match.group(0).rstrip(".,;:!?")
        try:
            ext = os.path.splitext(urllib.parse.urlsplit(url).path)[1].lower()
        except ValueError:
            continue
        if ext in IMAGE_EXT:
            found.append(url)
    return list(dict.fromkeys(found))[:MAX_IMAGES]


def fetch_image(url, site, until):
    for _ in range(MAX_REDIRECTS + 1):
        remaining = until - time.monotonic()
        if remaining <= 1:
            raise ValueError("download time budget used up")
        host, address, path = checked_target(url)
        if on_site(host, site):
            raise ValueError("hosted on the store's own domain")
        connection = PinnedHTTPSConnection(host, address, min(IMAGE_TIMEOUT_S, remaining))
        try:
            connection.request("GET", path, headers={"user-agent": "commerce-bench-assistant-bridge", "accept": "image/png,image/jpeg,image/webp"})
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader("location") or ""
                if not location:
                    raise ValueError("redirect without a location")
                url = urllib.parse.urljoin(url, location)
                continue
            if response.status != 200:
                raise ValueError(f"HTTP {response.status}")
            content_type = (response.getheader("content-type") or "").split(";")[0].strip().lower()
            if content_type not in IMAGE_TYPES:
                raise ValueError(f"content type {content_type or 'missing'}")
            length = response.getheader("content-length") or ""
            if length.isdigit() and int(length) > MAX_IMAGE_BYTES:
                raise ValueError("larger than the size cap")
            chunks = []
            size = 0
            while True:
                if time.monotonic() > until:
                    raise ValueError("download time budget used up")
                chunk = response.read(65536)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_IMAGE_BYTES:
                    raise ValueError("larger than the size cap")
                chunks.append(chunk)
            return b"".join(chunks)
        finally:
            connection.close()
    raise ValueError("too many redirects")


def download_images(reply, evidence_dir, site, until):
    saved = []
    try:
        links = image_links(reply)
    except Exception as error:
        log(f"skipped image links: {type(error).__name__}")
        return saved
    for url in links:
        label = "a link"
        try:
            label = urllib.parse.urlsplit(url).hostname or label
            body = fetch_image(url, site, until)
            kind, width, height = image_size(body)
            if not kind:
                raise ValueError("bytes are not a png, jpeg or webp image")
            if width < MIN_WIDTH or height < MIN_HEIGHT:
                raise ValueError(f"image is {width}x{height}, smaller than {MIN_WIDTH}x{MIN_HEIGHT}")
            name = f"linked-{len(saved) + 1}.{kind}"
            with open(os.path.join(evidence_dir, name), "wb") as handle:
                handle.write(body)
            saved.append(name)
        except Exception as error:
            log(f"skipped image link on {label}: {error if isinstance(error, ValueError) else type(error).__name__}")
    return saved


def load_channels(abench_dir):
    if not abench_dir:
        raise SetupError("set ABENCH_DIR to a checkout of anchorbrowser/assistant_benchmark")
    runner = os.path.join(abench_dir, "runner")
    if not os.path.isfile(os.path.join(runner, "channels.py")):
        raise SetupError("ABENCH_DIR does not contain runner/channels.py")
    sys.path.insert(0, runner)
    try:
        import channels
    except Exception as error:
        raise SetupError(f"could not import channels from ABENCH_DIR: {type(error).__name__}") from error
    return channels


def check_channel_env(kind, to, base):
    for group in CHANNEL_ENV.get(kind, []):
        if not any(os.environ.get(name) for name in group):
            raise SetupError(f"the {kind} channel needs {' or '.join(group)}")
    if kind == "cursor" and not to and not os.environ.get("ABENCH_CURSOR_WEBHOOK"):
        raise SetupError("the cursor channel needs --to or ABENCH_CURSOR_WEBHOOK")
    if kind == "cursor" and not base:
        raise SetupError("the cursor channel needs --base, for example --base env:ABENCH_BASE")
    if kind == "imessage" and not to and not os.environ.get("ABENCH_IMESSAGE_TO"):
        raise SetupError("the imessage channel needs --to or ABENCH_IMESSAGE_TO")
    if kind in ("browser", "play") and not os.path.isdir(BROWSER_PROFILE):
        raise SetupError(f"the {kind} channel needs a logged-in browser profile; log in once with: python3 \"$ABENCH_DIR/runner/channels.py\" login <chat url>")


def close_quietly(channel):
    try:
        with contextlib.redirect_stdout(RedactingStream(sys.__stderr__)):
            channel.close()
    except Exception:
        pass


def run_live(args, prompt, budget):
    to = resolve_value(args.to, "--to")
    base = resolve_value(args.base, "--base")
    check_channel_env(args.channel, to, base)
    with contextlib.redirect_stdout(RedactingStream(sys.__stderr__)):
        channels = load_channels(os.environ.get("ABENCH_DIR", ""))
        if args.channel not in channels.BUILDERS:
            raise SetupError(f"unknown channel {args.channel}; pick one of {', '.join(sorted(channels.BUILDERS))}")
        if args.channel == "openclaw" and hasattr(channels, "OpenClaw"):
            channels.OpenClaw._ensure_keys = lambda self: None
        try:
            channel = channels.build(args.channel, to, base)
        except channels.ChannelError as error:
            raise SetupError(f"channel setup failed: {error}") from error
    outcome = {}

    def work():
        with contextlib.redirect_stdout(RedactingStream(sys.__stderr__)):
            try:
                reply, _, _ = channels.run_channel(channel, prompt, budget, args.settle)
                outcome["reply"] = reply or ""
            except channels.ChannelError as error:
                outcome["setup"] = str(error)
            except Exception as error:
                outcome["error"] = type(error).__name__

    worker = threading.Thread(target=work, daemon=True)
    worker.start()
    worker.join(budget + JOIN_GRACE_S)
    close_quietly(channel)
    if worker.is_alive():
        return None
    if "setup" in outcome:
        raise SetupError(f"channel error: {outcome['setup']}")
    if "error" in outcome:
        raise SetupError(f"channel failed: {outcome['error']}")
    return outcome.get("reply", "")


def run(args):
    try:
        task = json.loads(sys.stdin.read())
    except json.JSONDecodeError:
        log("assistant-bridge: stdin is not a task JSON")
        return 2
    started = time.monotonic()
    evidence_dir = task.get("evidence_dir") or ""
    stop_at = task.get("stop_at") if task.get("stop_at") in STAGES else "shipping"
    if not evidence_dir:
        log("assistant-bridge: task has no evidence_dir")
        return 2
    os.makedirs(evidence_dir, exist_ok=True)
    deadline = int(task.get("deadline_s") or 720)
    budget = max(MIN_BUDGET_S, deadline - DEADLINE_MARGIN_S)
    if args.timeout:
        budget = min(budget, args.timeout)
    prompt = build_prompt(task, stop_at)

    try:
        if args.reply_file:
            with open(args.reply_file, encoding="utf-8", errors="replace") as handle:
                reply = handle.read()
            log(f"assistant-bridge: {args.assistant} offline, reply read from file, no channel and no image downloads")
        else:
            log(f"assistant-bridge: {args.assistant} on channel {args.channel}, waiting up to {budget}s")
            reply = run_live(args, prompt, budget)
    except SetupError as error:
        log(f"assistant-bridge: {error}")
        return 2
    except OSError as error:
        log(f"assistant-bridge: {type(error).__name__}: {error.strerror or error}")
        return 2

    if reply is None:
        emit({"status": "failed", "failure": {"code": "timeout", "message": f"no reply within {budget}s"}})
        sys.__stderr__.flush()
        os._exit(0)

    with open(os.path.join(evidence_dir, "transcript.txt"), "w", encoding="utf-8") as handle:
        handle.write(REDACT(reply))
    result = interpret(reply, stop_at)
    evidence = {}
    if reply.strip():
        evidence["transcript"] = "transcript.txt"
        if not args.reply_file:
            until = min(time.monotonic() + DOWNLOAD_BUDGET_S, started + deadline - 15)
            for index, name in enumerate(download_images(reply, evidence_dir, task.get("site"), until), start=1):
                evidence[f"linked_image_{index}"] = name
    if evidence:
        result["evidence"] = evidence
    emit(result)
    return 0


def main():
    parser = argparse.ArgumentParser(description="Run a consumer assistant on one Commerce Bench task (reported track).")
    parser.add_argument("--assistant", required=True)
    parser.add_argument("--channel", required=True)
    parser.add_argument("--to")
    parser.add_argument("--base")
    parser.add_argument("--timeout", type=int)
    parser.add_argument("--settle", type=int, default=25)
    parser.add_argument("--reply-file")
    args = parser.parse_args()
    for name in SECRET_ENV:
        REDACT.add(os.environ.get(name, ""))
    try:
        return run(args)
    except Exception as error:
        log(f"assistant-bridge: unexpected {type(error).__name__}: {error}")
        emit({"status": "failed", "failure": {"code": "", "message": f"bridge error: {type(error).__name__}"}})
        return 0


if __name__ == "__main__":
    sys.exit(main())
