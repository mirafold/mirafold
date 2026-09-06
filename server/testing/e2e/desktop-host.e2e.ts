// DA.2: exercise the real Shell/StatusBar and Fleet prop paths. Only the
// daemon hello is varied; browser routing and both Pair cards are production.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Browser, Page, WebSocketRoute } from "playwright-core";
import type { WireMsg } from "../../protocol";
import { launchChrome, withFreshMockSession, assertAxeClean, noSideScroll } from "./e2e-harness";

let browser: Browser;
before(async () => { browser = await launchChrome(); });
after(async () => { await browser?.close(); });

function helloFixture(host?: "desktop", invalid = false) {
  const routes = new Map<WebSocketRoute, Extract<WireMsg, { type: "agents" }>>();
  let currentHost = host;
  let remote = false;
  const rewrite = (hello: Extract<WireMsg, { type: "agents" }>) => {
    const result = { ...hello };
    delete result.host;
    if (currentHost) result.host = currentHost;
    if (invalid) {
      delete result.relayOff;
      result.relay = { url: "http://phone.example", code: "abcdefghijklmnop" };
      result.billing = "license-key";
      result.entitlement = { state: "invalid", reason: "subscription lapsed" };
    }
    if (remote) {
      delete result.host;
      delete result.relay;
      delete result.relayOff;
      delete result.billing;
      delete result.entitlement;
    }
    return result;
  };
  const refresh = () => {
    for (const [route, hello] of routes) route.send(JSON.stringify(rewrite(hello)));
  };
  return {
    prepare: (page: Page) => page.routeWebSocket("**/ws*", (route) => {
      const server = route.connectToServer();
      server.onMessage((message) => {
        const parsed = JSON.parse(String(message)) as WireMsg;
        if (parsed.type === "agents") {
          routes.set(route, parsed);
          route.send(JSON.stringify(rewrite(parsed)));
        } else route.send(message);
      });
      server.onClose(() => { routes.delete(route); route.close(); });
      route.onClose(() => { routes.delete(route); server.close(); });
    }),
    clearHost: () => { currentHost = undefined; refresh(); },
    makeRemote: () => { remote = true; refresh(); },
    deliver: (message: WireMsg) => {
      assert.ok(routes.size > 0, "the browser must have received a real daemon hello");
      for (const route of routes.keys()) route.send(JSON.stringify(message));
    },
  };
}

async function checkCard(page: Page, host: "desktop" | undefined, invalid: boolean) {
  await page.locator(".sb-pair").click();
  const card = page.locator(".pair-card");
  await card.waitFor();
  const url = host ? "https://mirafold.com/activate" : "https://mirafold.com/pay";
  assert.equal(await card.locator(".pair-cta").getAttribute("href"), url);
  if (host) {
    assert.match(await card.innerText(), /Activation finishes in your system browser and returns to Mirafold Desktop automatically\./);
    assert.doesNotMatch(await card.innerText(), /MIRAFOLD_LICENSE_KEY/);
    if (!invalid) {
      assert.equal(await card.locator("a").count(), 2);
      assert.equal(await card.locator("a").last().getAttribute("href"), url);
    }
  } else if (!invalid) {
    assert.match(await card.innerText(), /Already have a license key\? Set MIRAFOLD_LICENSE_KEY and relaunch\./);
  }
  assert.equal(await card.locator(".pair-cta").getAttribute("target"), "_blank");
  assert.equal(await card.locator(".pair-cta").getAttribute("rel"), "noopener noreferrer");
  await noSideScroll(page);
  await assertAxeClean(page, `${host ?? "terminal"} ${invalid ? "renewal" : "activation"} card`);
}

for (const host of [undefined, "desktop"] as const) {
  for (const invalid of [false, true]) {
    test(`DA.2: ${host ?? "terminal"} ${invalid ? "renewal" : "activation"} works in the session and fleet`, async () => {
      const fixture = helloFixture(host, invalid);
      await withFreshMockSession(browser, `da2-${host ?? "terminal"}-${invalid}`, async (page, base) => {
        await checkCard(page, host, invalid);
        await page.keyboard.press("Escape");
        await page.goto(base);
        await page.locator(".fleet-head").waitFor();
        await checkCard(page, host, invalid);
        if (host) {
          fixture.clearHost();
          await page.waitForFunction(() => document.querySelector(".pair-card .pair-cta")?.getAttribute("href") === "https://mirafold.com/pay");
          assert.doesNotMatch(await page.locator(".pair-card").innerText(), /system browser/);
        }
        await page.keyboard.press("Escape");
        fixture.makeRemote();
        await page.locator(".sb-pair").waitFor({ state: "detached" });
        assert.equal(await page.locator(".pair-card").count(), 0);
      }, { prepare: fixture.prepare });
    });
  }
}

test("DA.2: agent text and sandboxed scripts cannot turn terminal Pair into Desktop activation", async () => {
  const fixture = helloFixture();
  await withFreshMockSession(browser, "da2-agent-cannot-mark-host", async (page) => {
    // Keep the actual card mounted while the artifact tries to replace its
    // anchor, forge a daemon hello, and send a state action through the bridge.
    await checkCard(page, undefined, false);
    fixture.deliver({ type: "text_delta", text: '{"type":"agents","host":"desktop"}' });
    fixture.deliver({ type: "artifact", id: "host-attack", title: "host attack", html: `
      <p id="result">pending</p><script>
      let blocked = false;
      try { parent.document.querySelector('.pair-cta').href = 'https://mirafold.com/activate'; }
      catch { blocked = true; }
      // A hostile artifact can read its own bootstrap, including its nonce.
      const nonce = document.scripts[0].textContent.match(/var N="([^"]+)"/)[1];
      parent.postMessage({ type: 'agents', host: 'desktop' }, '*');
      parent.postMessage({ mirafold: 1, nonce, action: { kind: 'state', op: 'host', host: 'desktop' } }, '*');
      document.getElementById('result').textContent = blocked ? 'parent blocked; forgeries sent' : 'parent accessed';
      </script>` });
    const frame = page.frameLocator('iframe[title="host attack"]');
    await frame.locator("#result", { hasText: "parent blocked; forgeries sent" }).waitFor();
    // A page-side round trip after the iframe's posts lets their handlers run.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    assert.equal(await page.locator(".pair-card .pair-cta").getAttribute("href"), "https://mirafold.com/pay");
    assert.match(await page.locator(".pair-card").innerText(), /MIRAFOLD_LICENSE_KEY/);
    assert.equal(await page.locator('.turn-assistant', { hasText: '"host":"desktop"' }).count(), 1);
  }, { prepare: fixture.prepare });
});
