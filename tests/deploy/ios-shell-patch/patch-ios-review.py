#!/usr/bin/env python3
"""Normalise the iOS shell's Info.plist before an App Store build.

Why this exists
---------------
`HDdaraAi/dcloud-ios/` is excluded from git (the offline SDK is large), so it is
re-created from the DCloud template on every new machine. The template is copied
from a **mall** project: its usage descriptions talk about product photos,
nearby stores and shopping carts, and it declares purpose strings for modules
this shell does not even enable (Bluetooth printing, motion, calendars,
contacts, reminders, background location...). Shipping those invites reviewers
to ask why the app wants them — and none of them can be justified for a build
that only reads an API.

`Info.plist` is the real source of truth for an offline shell. The `ios.
privacyDescription` block inside `manifest.config.ts` is only consumed by
DCloud's cloud packer, so editing the manifest alone does **not** change what
lands in the IPA — which is exactly how the shipped build ended up advertising
Face ID for "login and payment verification" while the app has no payments.

Idempotent: safe to run on every build.
"""

import argparse
import plistlib
import sys

# Keys the shell actually enables. Everything else is dropped: the App uses the
# network, Face ID on iOS, and nothing else, so an unused purpose string is pure
# review risk.
ALLOWED = {
    "NSFaceIDUsageDescription",
    "NSLocationWhenInUseUsageDescription",
}

# Rewritten to this project's wording: what is collected, and what it is for.
REWRITE = {
    "NSFaceIDUsageDescription": (
        "用于快速解锁 HDdaraAi，验证后才能查看你的会话数据。"
    ),
    "NSLocationWhenInUseUsageDescription": (
        "用于在你主动挑选接入节点时定位就近的网关，仅在使用该功能时获取。"
    ),
}

# Declared by the template but never requested by this shell. Removal is what
# keeps the review from asking about capabilities the app does not use.
DROP_PREFIXES = (
    "NSBluetooth",
    "NSCalendars",
    "NSCamera",
    "NSContacts",
    "NSMicrophone",
    "NSMotion",
    "NSPhotoLibrary",
    "NSReminders",
    "NSSpeechRecognition",
    "NSUserTracking",
)

DROP_EXACT = {
    "NSLocationAlwaysAndWhenInUseUsageDescription",
    "NSLocationAlwaysUsageDescription",
    "NSLocationTemporaryUsageDescriptionDictionary",
    "NSLocationUsageDescription",
}


def patch(path: str) -> int:
    with open(path, "rb") as handle:
        data = plistlib.load(handle)

    changes: list[str] = []

    # 1. Drop every purpose string the shell never triggers.
    for key in list(data.keys()):
        if key in DROP_EXACT or key.startswith(DROP_PREFIXES):
            del data[key]
            changes.append("drop %s" % key)

    # 2. Force this project's wording on the keys that remain.
    for key, value in REWRITE.items():
        if key not in data:
            data[key] = value
            changes.append("add %s" % key)
        elif data[key] != value:
            data[key] = value
            changes.append("rewrite %s" % key)

    with open(path, "wb") as handle:
        plistlib.dump(data, handle)

    if not changes:
        print("   ← 壳隐私声明已合规（无改动）")
    else:
        for item in changes:
            print("   ← %s" % item)

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plist", required=True, help="shell Info.plist to patch")
    args = parser.parse_args()

    try:
        return patch(args.plist)
    except FileNotFoundError:
        print("   [警告] 未找到 %s，跳过" % args.plist, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
