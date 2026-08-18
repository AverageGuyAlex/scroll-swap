/* Rotulus service worker.

   It exists for exactly one reason: on iOS a notification banner can only be
   shown via ServiceWorkerRegistration.showNotification(), because the
   Notification constructor does not exist there. There is NO push here.

   There is also, deliberately, NO fetch handler. No fetch handler means no
   caching, which means this can never serve stale content. That matters: a
   caching service worker survives a redeploy and there is no ?v= bump that
   would rescue it.

   To remove this from devices that already installed it, ship a version of
   this file whose activate handler calls self.registration.unregister().
   Deleting the file is NOT enough — browsers keep the last copy they saw. */

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil((async function () {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const onPomodoro = all.find(function (c) { return c.url.indexOf('pomodoro') !== -1; });
    if (onPomodoro) return onPomodoro.focus();
    if (all.length) return all[0].focus();
    return self.clients.openWindow('/pomodoro.html');
  })());
});
