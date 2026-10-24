/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Baseline container boundary, not Arc profiles or Zen workspace isolation.
add_task(async function test_container_cookies_but_shared_extension_state() {
  await SpecialPowers.pushPrefEnv({
    set: [["privacy.userContext.enabled", true]],
  });
  const { ContextualIdentityService } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
  );
  const identities = [];
  const tabs = [];
  let extension;
  registerCleanupFunction(async () => {
    try {
      if (extension?.state === "running") {
        await extension.unload();
      }
    } finally {
      try {
        for (const tab of tabs) {
          if (tab.isConnected) {
            await BrowserTestUtils.removeTab(tab);
          }
        }
      } finally {
        for (const { userContextId } of identities) {
          Services.cookies.removeCookiesWithOriginAttributes(
            JSON.stringify({ userContextId }),
          );
          ContextualIdentityService.remove(userContextId);
        }
      }
    }
  });

  const url = "https://example.com/";
  for (const name of ["Boundary A", "Boundary B"]) {
    const identity = ContextualIdentityService.create(
      name,
      "fingerprint",
      "blue",
    );
    identities.push(identity);
    const tab = BrowserTestUtils.addTab(gBrowser, url, {
      userContextId: identity.userContextId,
      skipAnimation: true,
    });
    tabs.push(tab);
    await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
    Assert.equal(
      tab.userContextId,
      identity.userContextId,
      "Tab uses its container",
    );
  }
  Assert.notEqual(
    tabs[0].userContextId,
    tabs[1].userContextId,
    "Distinct containers",
  );

  async function cookie(tab, value) {
    return SpecialPowers.spawn(tab.linkedBrowser, [value], (marker) => {
      if (marker !== undefined) {
        content.document.cookie = `zen_boundary_probe=${marker}; Path=/; Secure; SameSite=Lax`;
      }
      return (
        content.document.cookie
          .split("; ")
          .find((item) => item.startsWith("zen_boundary_probe=")) || ""
      );
    });
  }
  Assert.equal(
    await cookie(tabs[0]),
    "",
    "Container A starts without the cookie",
  );
  Assert.equal(
    await cookie(tabs[0], "A"),
    "zen_boundary_probe=A",
    "A writes its cookie",
  );
  Assert.equal(await cookie(tabs[1]), "", "Container B cannot see A's cookie");
  Assert.equal(
    await cookie(tabs[1], "B"),
    "zen_boundary_probe=B",
    "B writes its cookie",
  );
  Assert.equal(
    await cookie(tabs[0]),
    "zen_boundary_probe=A",
    "B did not overwrite A's cookie",
  );

  extension = ExtensionTestUtils.loadExtension({
    useAddonManager: "temporary",
    manifest: {
      manifest_version: 2,
      permissions: ["storage", "cookies", "https://example.com/*"],
      background: { persistent: true },
    },
    background() {
      const nonce = crypto.randomUUID();
      let calls = 0;
      browser.runtime.onMessage.addListener(async ({ marker }, sender) => {
        const { sentinel: previous } =
          await browser.storage.local.get("sentinel");
        if (marker !== undefined) {
          await browser.storage.local.set({ sentinel: marker });
        }
        const { sentinel } = await browser.storage.local.get("sentinel");
        return {
          cookieStoreId: sender.tab.cookieStoreId,
          extensionId: browser.runtime.id,
          nonce,
          calls: ++calls,
          previous,
          sentinel,
        };
      });
      browser.test.onMessage.addListener(async (cookieStoreId, marker) => {
        try {
          const matches = await browser.tabs.query({ cookieStoreId });
          browser.test.assertEq(
            1,
            matches.length,
            "One probe tab in this container",
          );
          const [result] = await browser.tabs.executeScript(matches[0].id, {
            code: `browser.runtime.sendMessage(${JSON.stringify({ marker })})`,
          });
          browser.test.sendMessage("probe-result", result);
        } catch (error) {
          browser.test.fail(error.message);
          browser.test.sendMessage("probe-result", { error: error.message });
        }
      });
      browser.test.sendMessage("ready");
    },
  });
  await extension.startup();
  await extension.awaitMessage("ready");

  async function probe(index, marker) {
    const cookieStoreId = `firefox-container-${identities[index].userContextId}`;
    extension.sendMessage(cookieStoreId, marker);
    const result = await extension.awaitMessage("probe-result");
    Assert.equal(
      result.error,
      undefined,
      "Real tab-to-background message succeeded",
    );
    Assert.equal(
      result.cookieStoreId,
      cookieStoreId,
      "Background sees the sender's container",
    );
    Assert.equal(
      result.extensionId,
      extension.id,
      "Both containers use the installed extension",
    );
    return result;
  }
  const a = await probe(0, "from-A");
  Assert.ok(a.nonce, "Background has a runtime nonce");
  Assert.equal(a.calls, 1, "First request reaches the background");
  Assert.equal(
    a.previous,
    undefined,
    "Temporary extension starts with no sentinel",
  );
  Assert.equal(a.sentinel, "from-A", "A writes storage.local");

  const b = await probe(1, "from-B");
  Assert.equal(b.nonce, a.nonce, "B reaches the same background runtime as A");
  Assert.equal(b.calls, 2, "Background memory is shared across containers");
  Assert.equal(b.previous, "from-A", "B reads A's storage.local sentinel");
  Assert.equal(b.sentinel, "from-B", "B overwrites the shared sentinel");

  const again = await probe(0);
  Assert.equal(again.nonce, a.nonce, "A still reaches the same runtime");
  Assert.equal(again.calls, 3, "Shared background handled all three requests");
  Assert.equal(again.sentinel, "from-B", "A reads B's storage.local write");
  Assert.equal(
    await cookie(tabs[0]),
    "zen_boundary_probe=A",
    "A's cookie remains isolated",
  );
  Assert.equal(
    await cookie(tabs[1]),
    "zen_boundary_probe=B",
    "B's cookie remains isolated",
  );
});
