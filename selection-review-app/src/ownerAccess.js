function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

const nonEmpty = value => typeof value === "string" && value.trim() !== "";
// The local owner shows only an id; a team account also its display name and role (boss or tester).
function validUser(providerType, user) {
  if (providerType === "team_accounts") {
    return exactKeys(user, ["userId", "displayName", "role"]) && nonEmpty(user.userId) && nonEmpty(user.displayName) &&
      ["boss", "tester"].includes(user.role);
  }
  return exactKeys(user, ["userId"]) && nonEmpty(user.userId);
}

export function assertOwnerAccessDto(value) {
  if (!exactKeys(value, ["providerType", "status", "user"]) ||
      !["development_default", "local_owner_password", "team_accounts"].includes(value.providerType) ||
      (value.providerType === "development_default" ? value.status !== "development_only" :
        !(value.providerType === "team_accounts" ? ["login_required", "authenticated"] : ["setup_required", "login_required", "authenticated"]).includes(value.status)) ||
      (value.status === "authenticated" ? !validUser(value.providerType, value.user) : value.user !== null)) {
    throw new Error("主人登录状态格式无效，当前身份尚未确认。");
  }
  return value;
}

function checkedPassword(password, label) {
  if (typeof password !== "string" || password.length === 0) throw new Error(`请填写${label}。`);
  if (password.includes("\0") || new TextEncoder().encode(password).byteLength > 1024) throw new Error(`${label}不能含空字符，且最多1024字节。`);
  return password;
}

export function ownerAccessPasswordInput({ access, password, repeatedPassword, loginName }) {
  assertOwnerAccessDto(access);
  if (!["setup_required", "login_required"].includes(access.status)) throw new Error("当前状态不能提交密码，请重新读取登录状态。");
  if (access.providerType === "team_accounts") {
    if (typeof loginName !== "string" || loginName.trim() === "") throw new Error("请填写登录名。");
    // Passwords are opaque input; do not trim or normalize their characters.
    return { loginName: loginName.trim(), password: checkedPassword(password, "密码") };
  }
  if (typeof password !== "string" || password.length === 0) throw new Error("请填写主人密码。");
  if (password.includes("\0") || new TextEncoder().encode(password).byteLength > 1024) throw new Error("主人密码不能含空字符，且最多1024字节。");
  if (access.status === "setup_required" && [...password].length < 4) throw new Error("请设置至少4个字符的主人密码。");
  if (access.status === "setup_required" && password !== repeatedPassword) throw new Error("两次输入的密码不一致。");
  return { password };
}

export const TEAM_PASSWORD_MIN_CHARACTERS = 8;

/** A new team password, typed twice; the server checks it again. */
export function teamNewPasswordInput({ newPassword, repeatedPassword }) {
  checkedPassword(newPassword, "新密码");
  if ([...newPassword].length < TEAM_PASSWORD_MIN_CHARACTERS) throw new Error(`新密码至少${TEAM_PASSWORD_MIN_CHARACTERS}个字符。`);
  if (newPassword !== repeatedPassword) throw new Error("两次输入的新密码不一致。");
  return newPassword;
}

export const TEAM_ROLE_LABELS = Object.freeze({ boss: "老板", tester: "测试" });
