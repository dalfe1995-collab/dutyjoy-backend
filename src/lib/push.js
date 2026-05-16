const webpush = require('web-push');
const prisma   = require('./prisma');

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || 'BL1S8OAiNVLdDRl_0lT-EwsHWLDpyts1oZojTGdt3JgPrNUipn8b-k5wSez7uOjjQor4iRnLYZ-kc_HjJUGDUhA';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || 'ukyv8dcBwX3EKEYqCbymlIS1-zqrPXLDrMXpd2kz4fI';

webpush.setVapidDetails('mailto:info@dutyjoy.com', VAPID_PUBLIC, VAPID_PRIVATE);

module.exports.VAPID_PUBLIC = VAPID_PUBLIC;

/**
 * Send a push notification to all subscriptions of a user.
 * Silently removes expired/invalid subscriptions.
 */
module.exports.sendPush = async function sendPush(userId, { title, body, url = '/', icon = '/icons/icon-192.png', badge = '/icons/icon-96.png', tag }) {
  if (!userId) return;
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  if (!subs.length) return;

  const payload = JSON.stringify({ title, body, url, icon, badge, tag: tag || title });

  await Promise.allSettled(subs.map(async sub => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { TTL: 60 * 60 * 24 } // 24h TTL
      );
    } catch (err) {
      // 410 Gone = subscription expired; clean it up
      if (err.statusCode === 410 || err.statusCode === 404) {
        await prisma.pushSubscription.delete({ where: { endpoint: sub.endpoint } }).catch(() => {});
      }
    }
  }));
};
