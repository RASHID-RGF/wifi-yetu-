import sys, time, pathlib
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8777/"
OUT = pathlib.Path(__file__).parent / "_shots"
OUT.mkdir(exist_ok=True)

errors = []
with sync_playwright() as p:
    b = p.chromium.launch(args=["--enable-unsafe-swiftshader", "--use-gl=swiftshader"])
    pg = b.new_page(viewport={"width": 1440, "height": 860})
    pg.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
    pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    pg.goto(URL, wait_until="load")
    pg.wait_for_timeout(2500)
    pg.screenshot(path=str(OUT / "1_menu.png"))

    # start the race
    pg.click("#startBtn")
    pg.wait_for_timeout(1200)
    pg.screenshot(path=str(OUT / "2_countdown.png"))
    pg.wait_for_timeout(2600)

    # drive
    pg.keyboard.down("ArrowUp")
    pg.wait_for_timeout(4000)
    pg.screenshot(path=str(OUT / "3_race.png"))
    pg.keyboard.down("ArrowRight")
    pg.wait_for_timeout(1400)
    pg.keyboard.up("ArrowRight")
    pg.wait_for_timeout(1800)
    pg.screenshot(path=str(OUT / "4_curve.png"))

    # nitro
    pg.keyboard.down("Space")
    pg.wait_for_timeout(1500)
    pg.screenshot(path=str(OUT / "5_nitro.png"))
    pg.keyboard.up("Space")
    pg.keyboard.up("ArrowUp")

    # pause screen
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(700)
    pg.screenshot(path=str(OUT / "6_pause.png"))
    pg.keyboard.press("Escape")

    hud = pg.evaluate("""() => ({
      lap: document.getElementById('lapVal').textContent,
      pos: document.getElementById('posVal').textContent,
      time: document.getElementById('timeVal').textContent,
      speed: document.getElementById('speedVal').textContent,
      nitro: document.getElementById('nitroPct').textContent,
      dist: document.getElementById('distVal').textContent,
      segs: window.__segs ?? null
    })""")
    b.close()

print("HUD:", hud)
print("console issues:", errors if errors else "none")
print("shots:", sorted(p.name for p in OUT.glob("*.png")))
