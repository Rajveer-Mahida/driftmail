// Driftmail service worker — installable PWA + Web Push.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Data-less (or JSON) push → show a new-mail notification.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    /* data-less push */
  }
  const title = data.title || "New mail · Driftmail";
  const body = data.body || "You have new mail.";
  event.waitUntil(
    Promise.all([
      // Open tabs reload the list and the open conversation right away.
      self.clients
        .matchAll({ type: "window", includeUncontrolled: true })
        .then((all) => all.forEach((c) => c.postMessage({ type: "driftmail:new-mail" }))),
      self.registration.showNotification(title, {
        body,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        tag: "driftmail-new-mail",
        renotify: true,
        data: { url: data.url || "/" },
      }),
    ]),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of all) {
        if ("focus" in c) {
          c.navigate(url).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});

// Pass-through fetch handler (required for installability).
self.addEventListener("fetch", () => {});
