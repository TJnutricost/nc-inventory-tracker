// The effects notifier (Slice 5A; D-47 point 3, D4C-3): turns the after-commit effects of the PostgreSQL write paths
// (src/pg/effects.js) into email through a mailer (src/pg/mailer.js createPgMailer). NOT installed by the running app yet
// (Slice 5D calls installNotifier at boot).
//
// createNotifier(pool, mailer) -> fn(effect) for effects.setNotifier:
//   request_recorded { employeeId, assetId, requested, reserved, waitlisted } -> mailer.notify.requestRecorded
//   waitlist_joined  { waiterEmployeeId, assetId, entry, reserver, updated? } -> mailer.notify.waitlistJoined (updated: "changed their waitlist request")
//   hold_email       { entry }                                                  -> mailer.notify.waitlistHold
//   holds_owed       { assetId }                                                -> waitlist.dispatchHoldEmails(pool)
//   anything else: logged ('[notifier]') and ignored.
// People and the asset are resolved through the pool after COMMIT with the 4A emailOf / loadAsset, exactly as SQLite's flow
// resolved them; a person with no email address gets nothing (the mailer skips an empty recipient, as SQLite's send does).
// No loop and no duplicate: hold_email never triggers holds_owed, and holds_owed only runs the claim-based dispatchHoldEmails
// (each hold claimed once through hold_email_at), whose hold_email effects come back here and go to the mailer.
// installNotifier(pool, mailer) installs it and returns the uninstall function (back to the no-op notifier: nothing claimed).
const effects = require('./effects');
const reservations = require('./reservations');
const waitlist = require('./waitlist');

function createNotifier(pool, mailer) {
  const person = (id) => reservations.emailOf(pool, id);
  const asset = (id) => reservations.loadAsset(pool, id);
  return async function notifier(effect) {
    switch (effect && effect.type) {
      case 'request_recorded': {
        const { requested, reserved, waitlisted } = effect;
        return mailer.notify.requestRecorded(await person(effect.employeeId), await asset(effect.assetId), { requested, reserved, waitlisted });
      }
      case 'waitlist_joined':
        return mailer.notify.waitlistJoined(await person(effect.reserver.employee_id), await person(effect.waiterEmployeeId), await asset(effect.assetId),
          effect.entry, effect.reserver, { updated: !!effect.updated });
      case 'hold_email':
        return mailer.notify.waitlistHold(await person(effect.entry.employee_id), await asset(effect.entry.asset_id), effect.entry);
      case 'holds_owed':
        return waitlist.dispatchHoldEmails(pool);
      default:
        console.error('[notifier] unknown effect ignored:', effect && effect.type);
        return undefined;
    }
  };
}

function installNotifier(pool, mailer) {
  const fn = createNotifier(pool, mailer);
  effects.setNotifier(fn);
  return () => effects.setNotifier(null);
}

module.exports = { createNotifier, installNotifier };
