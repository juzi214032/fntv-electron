import * as fs from 'fs';
import * as path from 'node:path';
import * as crypto from 'crypto';
import { app, safeStorage } from 'electron';
import * as log from '../logger';
import { USER_DATA_PATH } from '../../public/constants';
import { isMpvPlaybackEnabled } from './playbackPreference';

const HISTORY_LIMIT = 5;
const ENCRYPTION_KEY = 'U2XDcFsV6rdTE9wB5ZHvy6BW9hBTKJ1H'; // 32 chars for aes-256
const IV = Buffer.alloc(16, 0); // Initialization vector
const SAFE_STORAGE_PREFIX = 'safe-storage:v1:';

app.setPath('userData', USER_DATA_PATH);

/**
 * 账号档案接口（快速切换用）
 */
export interface AccountProfile {
    domain: string;      // 服务器地址（含协议）
    account: string;     // 登录账号
    displayName: string; // 显示名称
    color: string;       // 按钮颜色
    lastToken?: string;  // 上次登录 token 缓存，用于免密直切
}

/**
 * 配置接口
 */
export interface Config {
    account?: string;
    domain?: string;
    token?: string;
    accessCode?: string;
    useHttps?: boolean;
    history?: HistoryItem[];
    accountProfiles?: AccountProfile[];
    downloadProxyEnabled?: boolean;
    downloadProxy?: string;
    hideOriginalPlayButton?: boolean;
    macCloseAction?: 'minimize' | 'quit' | 'ask';
    trayNotificationShown?: boolean;
    nasProxyEnabled?: boolean;
    mpvPlayerPath?: string;
    mpvVolume?: number;
    exitMode?: 'direct' | 'minimize' | 'ask';
}

/**
 * 历史记录项接口
 */
export interface HistoryItem {
    domain: string;
    account: string;
    password: string;
    accessCode?: string;
    useHttps?: boolean;
}

/**
 * 保存配置参数接口
 */
export interface SaveConfigParams {
    account: string;
    domain: string;
    token: string;
    accessCode?: string;
    useHttps?: boolean;
}

/**
 * 添加历史记录参数接口
 */
export interface AddHistoryParams {
    domain: string;
    account: string;
    password: string;
    accessCode?: string;
    useHttps?: boolean;
}

/**
 * 删除历史记录参数接口
 */
export interface DeleteHistoryParams {
    domain: string;
    account: string;
}

/**
 * 下载代理配置接口
 */
export interface DownloadProxyConfig {
    enabled: boolean;
    proxyUrl: string;
}

/**
 * 设置下载代理配置参数接口
 */
export interface SetDownloadProxyConfigParams {
    enabled?: boolean;
    proxyUrl?: string;
}

function getConfigPath(): string {
    const dir = app.getPath('userData');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, 'config.json');
}

// 仅用于读取旧版本固定密钥加密的密码。
// 旧版本（含 fork 早期版本）可能以明文存储过密码，非合法密文时按原值返回，交由调用方重新加密迁移。
function decryptLegacyPassword(encrypted: string): string {
    if (!/^[0-9a-fA-F]*$/.test(encrypted) || encrypted.length % 2 !== 0) {
        return encrypted;
    }
    try {
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), IV);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch {
        return encrypted;
    }
}

function encryptCredential(value: string): string {
    if (!value) return '';
    if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('操作系统安全存储不可用，无法保存登录凭据');
    }
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
        throw new Error('Linux 系统未提供可用的密钥环，拒绝以明文方式保存登录凭据');
    }
    return SAFE_STORAGE_PREFIX + safeStorage.encryptString(value).toString('base64');
}

function decryptCredential(value: string, isLegacyPassword: boolean): { value: string; legacy: boolean } {
    if (!value) return { value: '', legacy: false };
    if (value.startsWith(SAFE_STORAGE_PREFIX)) {
        try {
            return {
                value: safeStorage.decryptString(Buffer.from(value.slice(SAFE_STORAGE_PREFIX.length), 'base64')),
                legacy: false,
            };
        } catch (error) {
            log.error('safeStorage 解密失败，按原值处理:', error);
            return { value: '', legacy: false };
        }
    }
    return {
        value: isLegacyPassword ? decryptLegacyPassword(value) : value,
        legacy: true,
    };
}

function writeConfig(config: Config): void {
    const stored: Config = {
        ...config,
        token: encryptCredential(config.token || ''),
        accessCode: encryptCredential(config.accessCode || ''),
        history: config.history?.map(item => ({
            ...item,
            password: encryptCredential(item.password),
            accessCode: encryptCredential(item.accessCode || ''),
        })),
    };
    fs.writeFileSync(getConfigPath(), JSON.stringify(stored, null, 2));
}

// 读取配置
export function readConfig(): Config | null {
    const p = getConfigPath();
    if (fs.existsSync(p)) {
        try {
            const stored = JSON.parse(fs.readFileSync(p, 'utf-8')) as Config;
            const token = decryptCredential(stored.token || '', false);
            const accessCode = decryptCredential(stored.accessCode || '', false);
            let needsMigration = token.legacy || accessCode.legacy;
            const config: Config = {
                ...stored,
                token: token.value,
                accessCode: accessCode.value,
                history: stored.history?.map(item => {
                    const password = decryptCredential(item.password, true);
                    const historyAccessCode = decryptCredential(item.accessCode || '', false);
                    needsMigration ||= password.legacy || historyAccessCode.legacy;
                    return {
                        ...item,
                        password: password.value,
                        accessCode: historyAccessCode.value,
                    };
                }),
            };

            if (needsMigration && safeStorage.isEncryptionAvailable()) {
                writeConfig(config);
            }
            return config;
        } catch (error) {
            if (error instanceof SyntaxError) return null;
            throw error;
        }
    }
    return null;
}

// 保存配置（账号、域名、token、HTTPS设置）
export function saveConfig({ account, domain, token, accessCode, useHttps }: SaveConfigParams): void {
    const config: Config = readConfig() || {};
    config.account = account;
    config.domain = domain;
    config.token = token;
    if (accessCode !== undefined) config.accessCode = accessCode;
    config.useHttps = useHttps || false;
    writeConfig(config);
}

// 添加历史记录（域名、账号、加密密码、HTTPS设置）
export function addHistory({ domain, account, password, accessCode, useHttps }: AddHistoryParams): void {
    const config: Config = readConfig() || {};
    config.history = config.history || [];
    // 移除重复项
    config.history = config.history.filter(
        item => !(item.domain === domain && item.account === account)
    );
    // 添加新项
    config.history.unshift({
        domain,
        account,
        password,
        accessCode: accessCode || '',
        useHttps: useHttps || false
    });
    // 限制最多数量
    if (config.history.length > HISTORY_LIMIT) {
        config.history = config.history.slice(0, HISTORY_LIMIT);
    }
    writeConfig(config);
}

// 获取历史记录（解密密码）
export function getHistory(): HistoryItem[] {
    const config: Config = readConfig() || {};
    if (!config.history) return [];
    return config.history.map(item => ({
        domain: item.domain,
        account: item.account,
        password: item.password,
        accessCode: item.accessCode || '',
        useHttps: item.useHttps || false
    }));
}

// 清除历史记录
export function clearHistory(): void {
    const config: Config = readConfig() || {};
    config.history = [];
    writeConfig(config);
}

// 读取账号档案列表
export function getAccountProfiles(): AccountProfile[] {
    const config: Config = readConfig() || {};
    return config.accountProfiles || [];
}

// 新增/更新账号档案（按 domain+account 定位；更新时保持原有顺序）
export function upsertAccountProfile(profile: AccountProfile): void {
    const config: Config = readConfig() || {};
    config.accountProfiles = config.accountProfiles || [];
    const idx = config.accountProfiles.findIndex(
        item => normalizeDomain(item.domain) === normalizeDomain(profile.domain) && item.account === profile.account
    );
    if (idx >= 0) {
        config.accountProfiles[idx] = profile;
    } else {
        config.accountProfiles.push(profile);
    }
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 删除账号档案
export function removeAccountProfile(domain: string, account: string): void {
    const config: Config = readConfig() || {};
    if (!config.accountProfiles) return;
    config.accountProfiles = config.accountProfiles.filter(
        item => !(normalizeDomain(item.domain) === normalizeDomain(domain) && item.account === account)
    );
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

// 更新账号档案的 token 缓存
export function updateAccountToken(domain: string, account: string, token: string): void {
    const config: Config = readConfig() || {};
    if (!config.accountProfiles) return;
    const target = config.accountProfiles.find(
        item => normalizeDomain(item.domain) === normalizeDomain(domain) && item.account === account
    );
    if (target) {
        target.lastToken = token;
        fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
    }
}

// 域名归一化（去协议、去尾部斜杠，用于比较）
export function normalizeDomain(domain: string): string {
    return (domain || '').replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();
}

// 删除单个历史记录
export function deleteHistoryItem({ domain, account }: DeleteHistoryParams): boolean {
    const config: Config = readConfig() || {};
    if (!config.history) return false;
    
    const originalLength = config.history.length;
    config.history = config.history.filter(
        item => !(item.domain === domain && item.account === account)
    );
    
    if (config.history.length < originalLength) {
        writeConfig(config);
        return true;
    }
    return false;
}

// 获取下载代理配置
export function getDownloadProxyConfig(): DownloadProxyConfig {
    const config: Config = readConfig() || {};
    return {
        enabled: config.downloadProxyEnabled !== false, // 默认开启
        proxyUrl: config.downloadProxy || 'https://ghfast.top'
    };
}

// 设置下载代理配置
export function setDownloadProxyConfig({ enabled = true, proxyUrl = 'https://ghfast.top' }: SetDownloadProxyConfigParams = {}): void {
    const config: Config = readConfig() || {};
    config.downloadProxyEnabled = enabled;
    config.downloadProxy = proxyUrl;
    writeConfig(config);
}

// 获取是否启用 MPV 播放接管（沿用旧字段以兼容已有配置）
export function getHideOriginalPlayButton(): boolean {
    const config: Config = readConfig() || {};
    return isMpvPlaybackEnabled(config.hideOriginalPlayButton);
}

// 设置是否启用 MPV 播放接管
export function setHideOriginalPlayButton(enabled: boolean): void {
    const config: Config = readConfig() || {};
    config.hideOriginalPlayButton = enabled;
    writeConfig(config);
}

// 获取NAS本地网盘代理配置
export function getNasProxyEnabled(): boolean {
    const config: Config = readConfig() || {};
    return config.nasProxyEnabled === true; // 默认关闭
}

// 设置NAS本地网盘代理配置
export function setNasProxyEnabled(enabled: boolean): void {
    const config: Config = readConfig() || {};
    config.nasProxyEnabled = enabled;
    writeConfig(config);
}

// 获取 macOS 关闭行为偏好
export function getMacCloseAction(): 'minimize' | 'quit' | 'ask' {
    const config: Config = readConfig() || {};
    return config.macCloseAction || 'ask';
}

// 设置 macOS 关闭行为偏好
export function setMacCloseAction(action: 'minimize' | 'quit' | 'ask'): void {
    const config: Config = readConfig() || {};
    config.macCloseAction = action;
    writeConfig(config);
}

// 获取托盘通知是否已显示过
export function getTrayNotificationShown(): boolean {
    const config: Config = readConfig() || {};
    return config.trayNotificationShown || false;
}

// 设置托盘通知已显示状态
export function setTrayNotificationShown(shown: boolean): void {
    const config: Config = readConfig() || {};
    config.trayNotificationShown = shown;
    writeConfig(config);
}

// 获取MPV播放器路径配置
export function getMpvPlayerPath(): string | undefined {
    const config: Config = readConfig() || {};
    return config.mpvPlayerPath;
}

// 设置MPV播放器路径配置
export function setMpvPlayerPath(path: string | null): void {
    const config: Config = readConfig() || {};
    if (path === null || path === '') {
        delete config.mpvPlayerPath; // 清空配置
    } else {
        config.mpvPlayerPath = path;
    }
    writeConfig(config);
}

export function getMpvVolume(): number {
    const volume = readConfig()?.mpvVolume;
    return typeof volume === 'number' && Number.isFinite(volume)
        ? Math.min(100, Math.max(0, Math.round(volume)))
        : 70;
}

export function setMpvVolume(volume: number): void {
    if (!Number.isFinite(volume)) {
        throw new Error('MPV音量必须是有限数值');
    }

    const config: Config = readConfig() || {};
    config.mpvVolume = Math.min(100, Math.max(0, Math.round(volume)));
    writeConfig(config);
}

// 向后兼容的函数
export function getDownloadProxyUrl(): string {
    return getDownloadProxyConfig().proxyUrl;
}

export function setDownloadProxyUrl(proxyUrl: string): void {
    const current = getDownloadProxyConfig();
    setDownloadProxyConfig({ enabled: current.enabled, proxyUrl });
}

export function getExitMode(): 'direct' | 'minimize' | 'ask' {
    const config = readConfig();
    return config?.exitMode ?? 'ask';
}

export function setExitMode(mode: 'direct' | 'minimize' | 'ask'): void {
    const config = readConfig() ?? {};
    const updatedConfig = {
        ...config,
        exitMode: mode
    };
    writeConfig(updatedConfig);
}

// CommonJS导出，确保与现有代码兼容
module.exports = {
    saveConfig,
    readConfig,
    addHistory,
    getHistory,
    clearHistory,
    deleteHistoryItem,
    getAccountProfiles,
    upsertAccountProfile,
    removeAccountProfile,
    updateAccountToken,
    normalizeDomain,
    getDownloadProxyUrl,
    setDownloadProxyUrl,
    getDownloadProxyConfig,
    setDownloadProxyConfig,
    getHideOriginalPlayButton,
    setHideOriginalPlayButton,
    getNasProxyEnabled,
    setNasProxyEnabled,
    getMacCloseAction,
    setMacCloseAction,
    getTrayNotificationShown,
    setTrayNotificationShown,
    getMpvPlayerPath,
    setMpvPlayerPath,
    getMpvVolume,
    setMpvVolume,
    getExitMode,
    setExitMode
};
