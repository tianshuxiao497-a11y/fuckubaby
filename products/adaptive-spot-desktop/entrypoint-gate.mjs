// One signed grant state per worker process. The packaged CLI checks this same
// guard; directly launching the unmodified CLI cannot bypass desktop licensing.
import { createLeaseGuard } from './license-device.mjs';
export const desktopSubscription = createLeaseGuard({session:process.env.ASB_LICENSE_SESSION,deviceHash:process.env.ASB_LICENSE_DEVICE_HASH});
export function assertLicensedDesktopEntry() {
  if(!process.connected || !desktopSubscription.active()) throw new Error('An active signed desktop subscription is required. Open Adaptive Spot Bot and activate your Whop license.');
}
