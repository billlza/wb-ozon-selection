import { randomUUID } from "node:crypto";
import path from "node:path";
import { createPrivateOwnerCredentialRepository } from "./local-owner-identity.mjs";
import { createPasswordVerifier } from "./scrypt-verifier.mjs";
import { newTeamPassword } from "./team-account-identity.mjs";
import { normalizeDisplayName, normalizeLoginName, publicTeamAccount, TEAM_ACCOUNT_ROLES } from "./team-account-store.mjs";

// The command line behind scripts/manage-team-accounts.mjs. Accounts are made here, never from the web page, so nobody
// who merely reaches the server can make themselves an account. Passwords are typed in (never passed as arguments) and
// nothing printed holds a password or a verifier.
export const TEAM_ACCOUNT_USAGE = [
  "manage-team-accounts.mjs list",
  "manage-team-accounts.mjs add --login <登录名> --name <显示名> --role boss|tester",
  "manage-team-accounts.mjs reset-password --login <登录名>",
  "manage-team-accounts.mjs disable --login <登录名>",
  "manage-team-accounts.mjs enable --login <登录名>",
  "manage-team-accounts.mjs import-owner --from /绝对路径/owner.json --login <登录名> --name <显示名>"
].join("\n");

export class TeamAccountCommandError extends Error {
  constructor(message) { super(message); this.name = "TeamAccountCommandError"; }
}

function options(args, allowed) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.startsWith("--") ? args[index].slice(2) : null;
    if (key === null || !allowed.includes(key) || Object.hasOwn(values, key) || typeof args[index + 1] !== "string") {
      throw new TeamAccountCommandError(`参数不对。用法：\n${TEAM_ACCOUNT_USAGE}`);
    }
    values[key] = args[index + 1];
  }
  if (allowed.some(key => !Object.hasOwn(values, key))) throw new TeamAccountCommandError(`参数不全。用法：\n${TEAM_ACCOUNT_USAGE}`);
  return values;
}

function loginName(value) {
  const name = normalizeLoginName(value);
  if (name === null) throw new TeamAccountCommandError("登录名要2到32个字符：小写字母、数字、点、下划线或减号，以字母或数字开头");
  return name;
}

function displayName(value) {
  const name = normalizeDisplayName(value);
  if (name === null) throw new TeamAccountCommandError("显示名要1到40个字符");
  return name;
}

async function newPassword(readPassword, label) {
  const password = await readPassword(`${label}：`);
  try { newTeamPassword(password); }
  catch (error) { throw new TeamAccountCommandError(error.message); }
  const repeated = await readPassword("再输一遍：");
  if (repeated !== null && repeated !== password) throw new TeamAccountCommandError("两次输入的密码不一样，什么都没改");
  return password;
}

async function existing(store, name) {
  const account = await store.findByLoginName(loginName(name));
  if (!account) throw new TeamAccountCommandError("没有这个登录名");
  return account;
}

/**
 * Runs one command. `readPassword(prompt)` returns what was typed; it returns null for the repeat when the password came
 * from a pipe rather than a keyboard. `print` gets one line of plain text or one object to show as JSON.
 */
export async function runTeamAccountCommand({ args, store, readPassword, print }) {
  const [command, ...rest] = args;
  if (command === "list") {
    options(rest, []);
    print({ accounts: (await store.list()).map(publicTeamAccount) });
    return;
  }
  if (command === "add") {
    const input = options(rest, ["login", "name", "role"]);
    const name = loginName(input.login);
    if (!TEAM_ACCOUNT_ROLES.includes(input.role)) throw new TeamAccountCommandError("角色只能是 boss（老板）或 tester（测试）");
    if (await store.findByLoginName(name)) throw new TeamAccountCommandError("这个登录名已经有人用了");
    const verifier = await createPasswordVerifier(await newPassword(readPassword, `给 ${name} 设密码`));
    const account = await store.create({ userId: `team-user:${randomUUID()}`, loginName: name, displayName: displayName(input.name),
      role: input.role, verifier });
    print({ created: publicTeamAccount(account) });
    return;
  }
  if (command === "reset-password") {
    const account = await existing(store, options(rest, ["login"]).login);
    const verifier = await createPasswordVerifier(await newPassword(readPassword, `给 ${account.loginName} 设新密码`));
    print({ updated: publicTeamAccount(await store.setPassword({ userId: account.userId, verifier, expectedRevision: account.credentialRevision })) });
    return;
  }
  if (command === "disable" || command === "enable") {
    const account = await existing(store, options(rest, ["login"]).login);
    const status = command === "disable" ? "disabled" : "active";
    if (account.status === status) { print(`${account.loginName} 本来就是${status === "active" ? "可用" : "停用"}的，没有改`); return; }
    print({ updated: publicTeamAccount(await store.setStatus({ userId: account.userId, status, expectedRevision: account.credentialRevision })) });
    return;
  }
  if (command === "import-owner") {
    // The owner's account from the Mac's local owner password file: the same user id, so the owner's earlier confirmations
    // stay theirs, and the same password.
    const input = options(rest, ["from", "login", "name"]);
    if (!path.isAbsolute(input.from)) throw new TeamAccountCommandError("--from 要写绝对路径");
    const name = loginName(input.login);
    const record = await createPrivateOwnerCredentialRepository({ filePath: input.from, protectedPaths: [] }).read();
    if (record === null) throw new TeamAccountCommandError("那个位置没有主人密码文件");
    if (await store.findByUserId(record.ownerId)) throw new TeamAccountCommandError("主人账号已经导入过了");
    if (await store.findByLoginName(name)) throw new TeamAccountCommandError("这个登录名已经有人用了");
    const account = await store.create({ userId: record.ownerId, loginName: name, displayName: displayName(input.name), role: "boss",
      verifier: record.verifier });
    print({ imported: publicTeamAccount(account) });
    return;
  }
  throw new TeamAccountCommandError(`没有这个命令。用法：\n${TEAM_ACCOUNT_USAGE}`);
}
