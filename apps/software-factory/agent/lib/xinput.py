#!/usr/bin/env python3
"""Mouse and keyboard on an X display, through the XTEST extension (libXtst), like xdotool.

  xinput.py move X Y
  xinput.py click X Y [BUTTON] [COUNT]     BUTTON 1 left, 2 middle, 3 right
  xinput.py drag X1 Y1 X2 Y2
  xinput.py scroll X Y AMOUNT              AMOUNT > 0 scrolls down, < 0 up, in wheel clicks
  xinput.py type TEXT
  xinput.py key COMBO...                   ctrl+l, Return, shift+Tab, ctrl+shift+k

Only ctypes, since the sandbox has no pip; DISPLAY picks the display.
"""
import ctypes
import sys
import time

x11 = ctypes.CDLL("libX11.so.6")
xtst = ctypes.CDLL("libXtst.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XStringToKeysym.restype = ctypes.c_ulong
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
x11.XKeysymToKeycode.restype = ctypes.c_ubyte
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XGetKeyboardMapping.restype = ctypes.POINTER(ctypes.c_ulong)
x11.XGetKeyboardMapping.argtypes = [ctypes.c_void_p, ctypes.c_ubyte, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
x11.XChangeKeyboardMapping.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_ulong), ctypes.c_int]
x11.XDisplayKeycodes.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)]
x11.XFree.argtypes = [ctypes.c_void_p]
x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
x11.XFlush.argtypes = [ctypes.c_void_p]
for name, args in {
    "XTestFakeMotionEvent": [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong],
    "XTestFakeButtonEvent": [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong],
    "XTestFakeKeyEvent": [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong],
}.items():
    getattr(xtst, name).argtypes = args

dpy = x11.XOpenDisplay(None)
if not dpy:
    sys.exit("can't open the display: is Xvfb running, and DISPLAY set?")

ALIASES = {
    "ctrl": "Control_L", "control": "Control_L", "shift": "Shift_L", "alt": "Alt_L", "super": "Super_L",
    "meta": "Super_L", "cmd": "Super_L", "enter": "Return", "return": "Return", "esc": "Escape",
    "escape": "Escape", "tab": "Tab", "backspace": "BackSpace", "delete": "Delete", "del": "Delete",
    "space": "space", "up": "Up", "down": "Down", "left": "Left", "right": "Right", "home": "Home",
    "end": "End", "pageup": "Prior", "pagedown": "Next", "plus": "plus", "minus": "minus",
}


def sync(pause=0.0):
    x11.XSync(dpy, 0)
    if pause:
        time.sleep(pause)


def move(x, y):
    xtst.XTestFakeMotionEvent(dpy, -1, int(x), int(y), 0)
    sync(0.02)


def button(b, down):
    xtst.XTestFakeButtonEvent(dpy, int(b), 1 if down else 0, 0)
    sync(0.02)


def keysym(name):
    named = ALIASES.get(name.lower(), name)
    ks = x11.XStringToKeysym(named.encode())
    if ks == 0 and len(name) == 1:
        ks = char_keysym(name)
    if ks == 0:
        sys.exit(f"unknown key: {name}")
    return ks


def char_keysym(ch):
    cp = ord(ch)
    if ch == "\n":
        return x11.XStringToKeysym(b"Return")
    if ch == "\t":
        return x11.XStringToKeysym(b"Tab")
    return cp if 0x20 <= cp <= 0x7E or 0xA0 <= cp <= 0xFF else 0x01000000 + cp


_spare = None


def keycode_for(ks):
    """A keycode that types ks, and whether it needs shift. Unmapped keysyms go on a spare keycode."""
    global _spare
    kc = x11.XKeysymToKeycode(dpy, ks)
    if kc:
        n = ctypes.c_int()
        syms = x11.XGetKeyboardMapping(dpy, kc, 1, ctypes.byref(n))
        shifted = n.value > 1 and syms[0] != ks and syms[1] == ks
        x11.XFree(syms)
        return kc, shifted
    if _spare is None:
        lo, hi = ctypes.c_int(), ctypes.c_int()
        x11.XDisplayKeycodes(dpy, ctypes.byref(lo), ctypes.byref(hi))
        _spare = hi.value - 1
    mapping = (ctypes.c_ulong * 2)(ks, ks)
    x11.XChangeKeyboardMapping(dpy, _spare, 2, mapping, 1)
    sync(0.05)
    return _spare, False


def key(kc, down):
    xtst.XTestFakeKeyEvent(dpy, kc, 1 if down else 0, 0)
    sync(0.008)


def combo(spec):
    names = spec.split("+") if spec != "+" else ["plus"]
    codes = [keycode_for(keysym(n))[0] for n in names]
    for kc in codes:
        key(kc, True)
    for kc in reversed(codes):
        key(kc, False)


def type_text(text):
    shift = x11.XKeysymToKeycode(dpy, x11.XStringToKeysym(b"Shift_L"))
    for ch in text:
        kc, shifted = keycode_for(char_keysym(ch))
        if shifted:
            key(shift, True)
        key(kc, True)
        key(kc, False)
        if shifted:
            key(shift, False)


def main(argv):
    if not argv:
        sys.exit(__doc__)
    cmd, args = argv[0], argv[1:]
    if cmd == "move":
        move(args[0], args[1])
    elif cmd == "click":
        move(args[0], args[1])
        b = int(args[2]) if len(args) > 2 else 1
        for _ in range(int(args[3]) if len(args) > 3 else 1):
            button(b, True)
            button(b, False)
            time.sleep(0.05)
    elif cmd == "drag":
        x1, y1, x2, y2 = (int(a) for a in args[:4])
        move(x1, y1)
        button(1, True)
        for i in range(1, 21):
            move(x1 + (x2 - x1) * i / 20, y1 + (y2 - y1) * i / 20)
        button(1, False)
    elif cmd == "scroll":
        move(args[0], args[1])
        amount = int(args[2])
        for _ in range(abs(amount)):
            b = 5 if amount > 0 else 4
            button(b, True)
            button(b, False)
    elif cmd == "type":
        type_text(" ".join(args))
    elif cmd == "key":
        for spec in args:
            combo(spec)
    else:
        sys.exit(__doc__)
    sync()


main(sys.argv[1:])
