import asyncio, json, os
from playwright.async_api import async_playwright

URL = "http://127.0.0.1:8000/uploads/msaralugstealalmee.html"
PAGES = ["mainPage","trackingPage","myShipmentsPage","addShipmentPage","warehousesPage","calculatorPage",
         "walletPage","merchantsPage","statisticsPage","globalPortalPage","branchesPage","settingsPage",
         "reportsPage","crmPage","fleetPage","analyticsPage","promotionsPage","feedbackPage","contractsPage"]

async def main():
    os.makedirs("/home/user/audit/shots", exist_ok=True)
    report = {"console_errors": [], "page_errors": [], "pages": {}, "flows": {}}
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 420, "height": 900}, locale="ar")
        page = await ctx.new_page()
        page.on("console", lambda m: report["console_errors"].append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: report["page_errors"].append(str(e)))
        await page.goto(URL, wait_until="load")
        await page.wait_for_timeout(1500)
        # login
        await page.fill("#loginIdentifier", "taha123")
        await page.fill("#loginPassword", "12580taha")
        await page.click("button.login-btn")
        await page.wait_for_timeout(1200)
        report["login_ok"] = await page.is_visible("#appContainer")
        try:
            await page.click(".welcome-btn", timeout=2000)
        except Exception:
            pass
        await page.wait_for_timeout(400)

        for pid in PAGES:
            before_err = len(report["page_errors"])
            try:
                await page.evaluate(f"navigateTo('{pid}')")
            except Exception as e:
                report["pages"][pid] = {"nav_error": str(e)}
                continue
            await page.wait_for_timeout(900)
            info = await page.evaluate("""(pid) => {
                const el = document.getElementById(pid);
                if (!el) return {missing:true};
                const vis = el.offsetHeight > 0;
                const txt = (el.innerText||'').trim();
                const buttons = el.querySelectorAll('button,[onclick]').length;
                const empty = [];
                el.querySelectorAll('[id]').forEach(n => {
                    if (n.children.length === 0 && !n.innerText.trim() && !['INPUT','SELECT','TEXTAREA','CANVAS','IMG','I','SPAN'].includes(n.tagName)) empty.push(n.id);
                });
                const canvases = [...el.querySelectorAll('canvas')].map(c => ({id:c.id, w:c.width, h:c.height}));
                return {visible:vis, textLen:txt.length, buttons, emptyContainers:empty, canvases};
            }""", pid)
            info["nav_pageerrors"] = report["page_errors"][before_err:]
            report["pages"][pid] = info
            try:
                await page.screenshot(path=f"/home/user/audit/shots/{pid}.png", full_page=False)
            except Exception:
                pass

        # ---- flows ----
        # tracking
        await page.evaluate("navigateTo('trackingPage')")
        await page.fill("#trackInput", "HDTA6351661")
        await page.click("button.search-trigger-btn:has-text('بحث')")
        await page.wait_for_timeout(2200)
        report["flows"]["tracking"] = await page.evaluate("""() => ({
            resultVisible: getComputedStyle(document.getElementById('resultCard')).display,
            mapVisible: getComputedStyle(document.getElementById('mapContainer')).display,
            leafletTiles: document.querySelectorAll('#shipmentMap img.leaflet-tile').length,
            infoItems: document.querySelectorAll('#resInfoGrid .info-item').length,
            errorShown: getComputedStyle(document.getElementById('errorMsg')).display
        })""")
        await page.screenshot(path="/home/user/audit/shots/flow_tracking.png")

        # shipments filters
        await page.evaluate("navigateTo('myShipmentsPage')")
        await page.wait_for_timeout(600)
        report["flows"]["shipments"] = await page.evaluate("""() => ({
            cards: document.querySelectorAll('#shipmentsList .shipment').length,
            html: (document.getElementById('shipmentsList').innerText||'').slice(0,120)
        })""")
        # delivered filter (uses copyToClipboard handler)
        err_before = len(report["page_errors"])
        await page.evaluate("showDeliveredFilter()")
        await page.wait_for_timeout(600)
        cards = await page.evaluate("document.querySelectorAll('#shipmentsList .shipment').length")
        # click copy button inside delivered list -> tests copyToClipboard existence
        clicked = False
        try:
            await page.click("#shipmentsList .shipment button", timeout=2500)
            clicked = True
        except Exception:
            pass
        await page.wait_for_timeout(500)
        report["flows"]["delivered_filter"] = {"cards": cards, "copy_btn_clicked": clicked,
                                               "errors": report["page_errors"][err_before:]}

        # calculator
        await page.evaluate("navigateTo('calculatorPage')")
        await page.wait_for_timeout(600)
        await page.fill("#calcWeight", "100")
        await page.select_option("#calcSource", "UAE")
        await page.select_option("#calcDest", "OM")
        await page.select_option("#calcType", "heavy")
        await page.evaluate("calculateShipping()")
        await page.wait_for_timeout(400)
        report["flows"]["calculator"] = await page.evaluate("(document.getElementById('calcResult').innerText||'').replace(/\\s+/g,' ').slice(0,200)")

        # wallet
        await page.evaluate("navigateTo('walletPage')")
        await page.wait_for_timeout(900)
        report["flows"]["wallet"] = await page.evaluate("""() => ({
            cards: document.querySelectorAll('#walletAppContainer .card, #walletAppContainer .wallet-card').length,
            textLen: (document.getElementById('walletAppContainer').innerText||'').length
        })""")
        await page.screenshot(path="/home/user/audit/shots/flow_wallet.png")

        # portal
        await page.evaluate("navigateTo('globalPortalPage')")
        await page.wait_for_timeout(1500)
        report["flows"]["portal"] = await page.evaluate("""() => {
            const c = document.getElementById('globalPortalContainer');
            return { textLen: (c.innerText||'').length,
                     links: c.querySelectorAll('a[href^="http"]').length,
                     cards: c.querySelectorAll('.card').length,
                     favBtns: c.querySelectorAll('.favorite-btn').length };
        }""")
        await page.screenshot(path="/home/user/audit/shots/flow_portal.png")

        # statistics charts
        await page.evaluate("navigateTo('statisticsPage')")
        await page.wait_for_timeout(1500)
        report["flows"]["statistics"] = await page.evaluate("""() => ({
            statCards: document.querySelectorAll('#statsGrid .stat-card').length,
            charts: [...document.querySelectorAll('canvas')].map(c=>({id:c.id,w:c.width,h:c.height}))
        })""")
        await page.screenshot(path="/home/user/audit/shots/flow_stats.png")

        # settings as normal user
        await page.evaluate("navigateTo('settingsPage')")
        await page.wait_for_timeout(900)
        report["flows"]["settings_normal_user"] = await page.evaluate("""() => ({
            textLen: (document.getElementById('settingsContent')?.innerText||'').length,
            sections: document.querySelectorAll('#settingsContent .settings-section').length
        })""")

        # offline-ish check: localStorage keys
        report["storage_keys"] = await page.evaluate("Object.keys(localStorage)")

        # mobile viewport overflow
        await page.set_viewport_size({"width": 360, "height": 740})
        await page.evaluate("navigateTo('mainPage')")
        await page.wait_for_timeout(700)
        report["mobile"] = await page.evaluate("""() => ({
            docScrollW: document.documentElement.scrollWidth,
            clientW: document.documentElement.clientWidth,
            overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2
        })""")
        await page.screenshot(path="/home/user/audit/shots/mobile_main.png", full_page=False)

        # desktop width check (app is locked to 480px)
        await page.set_viewport_size({"width": 1440, "height": 900})
        await page.wait_for_timeout(500),
        report["desktop"] = await page.evaluate("""() => ({
            appW: document.getElementById('appContainer').getBoundingClientRect().width,
            vw: window.innerWidth
        })""")
        await page.screenshot(path="/home/user/audit/shots/desktop_main.png")

        await b.close()
    json.dump(report, open("/home/user/audit/report.json","w"), ensure_ascii=False, indent=1)
    print(json.dumps({k: report[k] for k in ["login_ok","page_errors","console_errors","flows","mobile","desktop","storage_keys"]}, ensure_ascii=False, indent=1)[:6000])
    print("\n--- PAGES ---")
    for k,v in report["pages"].items():
        print(k, v)

asyncio.run(main())
