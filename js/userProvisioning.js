// Create Auth identity and app profile as one recoverable operation. Existing
// identities are recovered only after the supplied password has been verified.
async function provisionAccount(adapter, email, password, profile) {
  let credential, created = false;
  try {
    try { credential = await adapter.create(email, password); created = true; }
    catch (error) {
      if (error.code !== 'auth/email-already-in-use') throw error;
      try { credential = await adapter.signIn(email, password); }
      catch (_) { throw new Error('This email already exists. Enter its current password to restore app access, or reset it in Firebase Console.'); }
    }
    const id = credential.user.uid;
    if (await adapter.findProfile(id)) throw new Error('This account already has an app profile. Use Edit or Activate.');
    await adapter.saveProfile(id, { ...profile, username: email, id });
    return id;
  } catch (error) {
    if (created && credential) {
      try { await adapter.deleteCreated(credential.user); }
      catch (_) { throw new Error(`Account created but profile not saved. Retry with the same email/password to recover. UID: ${credential.user.uid}`); }
    }
    throw error;
  }
}
