#!/usr/bin/env python3
"""Retry X login username-step every 90s until the rate limit lifts."""
import json, urllib.request, urllib.parse, time, sys, datetime

def interact(steps):
    p = {"steps": json.dumps(steps), "profile": "x", "proxy": "direct"}
    req = urllib.request.Request("http://127.0.0.1:7318/interact", data=urllib.parse.urlencode(p).encode())
    return json.load(urllib.request.urlopen(req, timeout=160))

STEPS = [
    {"action": "goto", "url": "https://x.com/i/jf/onboarding/web?mode=login"},
    {"action": "wait_ms", "ms": 9000},
    {"action": "fill", "selector": "input[name=username_or_email]", "value": "v4ntive"},
    {"action": "press", "key": "Enter"},
    {"action": "wait_ms", "ms": 12000},
    {"action": "eval", "expression": 'JSON.stringify({texto:document.body.innerText.slice(0,260), url:location.href})'},
]

for attempt in range(1, 13):
    now = datetime.datetime.now().strftime("%H:%M:%S")
    try:
        r = interact(STEPS)
        v = json.loads([s for s in r["step_results"] if s["action"] == "eval"][-1]["value"])
        limited = "temporarily limited" in v.get("texto", "")
        notfound = "couldn't find an active" in v.get("texto", "")
        print(f"[{now}] intento {attempt}: {'LIMITED' if limited else ('NOTFOUND??' if notfound else 'AVANCE: ' + v.get('texto','')[:90].replace(chr(10),' '))}", flush=True)
        if not limited and not notfound:
            print("El límite levantó: la pestaña quedó en el paso siguiente (clave/challenge).", flush=True)
            sys.exit(0)
    except Exception as e:
        print(f"[{now}] intento {attempt}: ERROR {e}", flush=True)
    time.sleep(90)
print("Sigue limitado tras ~18 min; probar con 'Continue with Google' en el noVNC.", flush=True)
sys.exit(1)
