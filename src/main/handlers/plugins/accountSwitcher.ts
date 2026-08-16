import { dialog, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import * as fn from '../../../modules/fn_api/api';
import * as fnConfig from '../../../modules/fn_config/config';
import { restoreCookies } from '../../../modules/fn_config/cookie';
import { registerHandler } from '../core/ipcHandler';
import { getMainWindow } from '../../common/mainwin';
import { stopCurrentPlayer } from './media';
import * as log from '../../../modules/logger';

/**
 * 账号快速切换插件
 * 在标题栏展示已配置的常用账号，一键切换登录
 */

interface ProfilePayload {
    domain: string;
    account: string;
    displayName: string;
    color: string;
}

// 渲染层可用的档案信息（不含 token）
function toProfilePayload(p: fnConfig.AccountProfile): ProfilePayload {
    return { domain: p.domain, account: p.account, displayName: p.displayName, color: p.color };
}

// 获取账号列表（invoke）
function handleGetAccounts(event: IpcMainInvokeEvent): { profiles: ProfilePayload[]; candidates: { domain: string; account: string }[]; current: { domain: string; account: string } } {
    const config = fnConfig.readConfig() || {};
    const profiles = fnConfig.getAccountProfiles().map(toProfilePayload);
    const profileKeys = new Set(profiles.map(p => `${fnConfig.normalizeDomain(p.domain)}|${p.account}`));

    // 候选 = 登录历史中尚未添加为档案的账号
    const candidates = (fnConfig.getHistory() || [])
        .filter(h => !profileKeys.has(`${fnConfig.normalizeDomain(h.domain)}|${h.account}`))
        .map(h => ({ domain: h.domain, account: h.account }));

    return {
        profiles,
        candidates,
        current: { domain: config.domain || '', account: config.account || '' }
    };
}

// 保存档案（新增/编辑）
function handleSaveProfile(event: IpcMainEvent, profile: ProfilePayload): void {
    if (!profile || !profile.domain || !profile.account) {
        log.error('保存账号档案失败: 缺少必要字段');
        return;
    }

    // 档案统一存裸域名（host[:port]），协议在切换时按登录历史解析
    const domain = profile.domain.replace(/^https?:\/\//, '');

    // 保留已有的 token 缓存
    const existing = fnConfig.getAccountProfiles().find(
        p => fnConfig.normalizeDomain(p.domain) === fnConfig.normalizeDomain(domain) && p.account === profile.account
    );
    fnConfig.upsertAccountProfile({
        domain,
        account: profile.account,
        displayName: profile.displayName || profile.account,
        color: profile.color || '#5b8def',
        lastToken: existing?.lastToken
    });
    event.reply('account-switcher-changed', {});
}

// 删除档案
function handleRemoveProfile(_event: IpcMainEvent, { domain, account }: { domain: string; account: string }): void {
    fnConfig.removeAccountProfile(domain, account);
}

// 用缓存 token 直切，失败返回 null 走密码重登
async function tryTokenSwitch(server: string, account: string): Promise<string | null> {
    const profile = fnConfig.getAccountProfiles().find(
        p => fnConfig.normalizeDomain(p.domain) === fnConfig.normalizeDomain(server) && p.account === account
    );
    if (!profile?.lastToken) return null;

    try {
        const fnapi = new fn.ApiService(server, profile.lastToken);
        const resp = await fnapi.getUserInfo(5000, 0);
        if (resp?.success) {
            log.info(`账号 ${account} 缓存 token 有效，免密切换`);
            return profile.lastToken;
        }
    } catch (e) {
        log.warn('缓存 token 校验异常，回退密码登录:', e);
    }
    return null;
}

// 密码重登兜底
async function loginByPassword(server: string, account: string): Promise<string | null> {
    const historyItem = (fnConfig.getHistory() || []).find(
        h => fnConfig.normalizeDomain(h.domain) === fnConfig.normalizeDomain(server) && h.account === account
    );
    if (!historyItem) {
        dialog.showErrorBox('切换失败', `登录历史中没有账号 ${account} 的密码记录，请先用该账号登录一次。`);
        return null;
    }

    const fnapi = new fn.ApiService(server.startsWith('http') ? server : `https://${server}`);
    const resp = await fnapi.login(account, historyItem.password);
    if (!resp?.success || !resp.data?.token) {
        const msg = resp?.certificateError
            ? '服务器证书验证失败，请先在登录页登录一次并信任证书。'
            : (resp?.message || '未知错误');
        dialog.showErrorBox('切换失败', `账号 ${account} 登录失败: ${msg}`);
        return null;
    }
    return resp.data.token;
}

// 解析服务器完整地址：以登录历史的 useHttps 为准（局域网 fnOS 常为 http）
function resolveServer(domain: string, account: string): string {
    const host = fnConfig.normalizeDomain(domain);
    const historyItem = (fnConfig.getHistory() || []).find(
        h => fnConfig.normalizeDomain(h.domain) === host && h.account === account
    );
    if (historyItem) {
        return `${historyItem.useHttps ? 'https' : 'http'}://${historyItem.domain}`;
    }
    return /^https?:\/\//.test(domain) ? domain : `https://${domain}`;
}

// 执行切换
async function handleSwitchAccount(_event: IpcMainEvent, { domain, account }: { domain: string; account: string }): Promise<void> {
    log.info(`请求切换账号: ${account} @ ${domain}`);
    const config = fnConfig.readConfig() || {};

    // 已是该账号则跳过
    if (config.account === account && fnConfig.normalizeDomain(config.domain || '') === fnConfig.normalizeDomain(domain)) {
        log.info('已经是当前账号，跳过切换');
        return;
    }

    const server = resolveServer(domain, account);

    // 播放中先停止，避免旧账号的播放回传污染进度
    stopCurrentPlayer();

    let token = await tryTokenSwitch(server, account);
    if (!token) {
        token = await loginByPassword(server, account);
    }
    if (!token) return;

    fnConfig.saveConfig({
        account,
        domain: server,
        token,
        useHttps: server.startsWith('https')
    });

    const ok = await restoreCookies(server, token, true);
    if (!ok) {
        dialog.showErrorBox('切换失败', '无法写入登录状态，请重试。');
        return;
    }

    // 缓存 token 供下次免密直切
    fnConfig.updateAccountToken(server, account, token);

    const mainWindow = getMainWindow();
    if (mainWindow) {
        log.info(`切换成功，跳转: ${server}/v`);
        mainWindow.loadURL(`${server}/v`);
    }
}

function init(): void {
    registerHandler('account-switcher-get', handleGetAccounts, { useHandle: true });
    registerHandler('account-switcher-save', handleSaveProfile);
    registerHandler('account-switcher-remove', handleRemoveProfile);
    registerHandler('account-switcher-switch', handleSwitchAccount);
    log.info('账号快速切换插件已初始化');
}

export {
    init
};
