/**
 * Mint a unique identity for one run.
 *
 * Registration is only meaningful for a user who does not exist yet, so every
 * run signs up under a fresh GitHub id / login. The local dev callback keys the
 * stub identity off `githubId`, and `users.username` is unique, so reusing a
 * value would sign the run in as the previous run's user instead of creating
 * one.
 *
 * Writes `GH_ID` and `GH_LOGIN` into the test env for later steps and for the
 * database fixtures, which look the user up by username.
 */
const id = String(Date.now() % 1_000_000_000);
const login = `e2e-user-${id}`;

setVariable("GH_ID", id);
setVariable("GH_LOGIN", login);

return login;
