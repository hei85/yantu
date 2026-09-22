// 本地单用户工作站的免登录开关。
//
// 启动脚本会把本机固定账号通过 VITE_LOCAL_AUTO_LOGIN_USER / VITE_LOCAL_AUTO_LOGIN_PASSWORD
// 注入到前端进程；两个变量都存在时，打开网页会自动建立会话，不再展示登录页。
// 没有注入时保持官方原有登录流程，方便多用户或对外部署时随时关掉免登录。
const localAutoLoginUsername = String(import.meta.env.VITE_LOCAL_AUTO_LOGIN_USER || "").trim();
const localAutoLoginPassword = String(import.meta.env.VITE_LOCAL_AUTO_LOGIN_PASSWORD || "");

export function localAutoLoginEnabled() {
    return Boolean(localAutoLoginUsername && localAutoLoginPassword);
}

export function localAutoLoginCredentials() {
    return { username: localAutoLoginUsername, password: localAutoLoginPassword };
}
