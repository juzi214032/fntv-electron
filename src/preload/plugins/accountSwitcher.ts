// preload/plugins/accountSwitcher.ts
// 标题栏账号快速切换按钮
import { ipcRenderer } from 'electron';
import { registerHook } from '../core/hooks';
import { HookType } from '../core/hooks';
import logger from '../core/logger';

interface ProfilePayload {
    domain: string;
    account: string;
    displayName: string;
    color: string;
}

interface AccountsData {
    profiles: ProfilePayload[];
    candidates: { domain: string; account: string }[];
    current: { domain: string; account: string };
}

const CONTAINER_ID = 'account-switcher';
const POPOVER_ID = 'account-switcher-popover';
const COLOR_PRESETS = ['#e74c3c', '#e67e22', '#d4a017', '#2ecc71', '#1abc9c', '#3498db', '#9b59b6', '#e84393'];

function normalizeDomain(domain: string): string {
    return (domain || '').replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();
}

function isActive(data: AccountsData, p: ProfilePayload): boolean {
    return data.current.account === p.account
        && normalizeDomain(data.current.domain) === normalizeDomain(p.domain);
}

function closePopover(): void {
    document.getElementById(POPOVER_ID)?.remove();
}

// 右键编辑弹窗：名称 + 颜色 + 删除
function openEditPopover(profile: ProfilePayload, anchor: HTMLElement, onChanged: () => void): void {
    closePopover();
    const pop = document.createElement('div');
    pop.id = POPOVER_ID;

    const rect = anchor.getBoundingClientRect();
    pop.style.cssText = `
        position: fixed; top: ${rect.bottom + 6}px; right: ${window.innerWidth - rect.right}px;
        background: rgba(30, 32, 38, 0.96); color: #eee; border-radius: 10px;
        padding: 14px; width: 220px; z-index: 100000;
        box-shadow: 0 8px 28px rgba(0,0,0,0.35); font-size: 13px;
        -webkit-app-region: no-drag;
    `;

    const title = document.createElement('div');
    title.textContent = `编辑 ${profile.account}`;
    title.style.cssText = 'font-weight: 600; margin-bottom: 10px; font-size: 12px; opacity: 0.85;';

    const nameInput = document.createElement('input');
    nameInput.value = profile.displayName;
    nameInput.placeholder = '显示名称';
    nameInput.style.cssText = `
        width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px;
        border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.08);
        color: #eee; outline: none; margin-bottom: 10px; font-size: 13px;
    `;

    const swatchRow = document.createElement('div');
    swatchRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px;';
    let selectedColor = profile.color;
    swatchRow.append(...COLOR_PRESETS.map(c => {
        const s = document.createElement('div');
        s.style.cssText = `
            width: 22px; height: 22px; border-radius: 50%; background: ${c}; cursor: pointer;
            border: 2px solid ${c === selectedColor ? '#fff' : 'transparent'};
        `;
        s.addEventListener('click', () => {
            selectedColor = c;
            swatchRow.querySelectorAll('div').forEach(d => (d as HTMLElement).style.border = `2px solid ${d === s ? '#fff' : 'transparent'}`);
        });
        return s;
    }));

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';

    const delBtn = document.createElement('button');
    delBtn.textContent = '移除';
    delBtn.style.cssText = 'background: transparent; border: 1px solid rgba(231,76,60,0.6); color: #e74c3c; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px;';
    delBtn.addEventListener('click', () => {
        ipcRenderer.send('account-switcher-remove', { domain: profile.domain, account: profile.account });
        closePopover();
        onChanged();
    });

    const saveBtn = document.createElement('button');
    saveBtn.textContent = '保存';
    saveBtn.style.cssText = 'background: #3498db; border: none; color: #fff; border-radius: 6px; padding: 4px 12px; cursor: pointer; font-size: 12px;';
    saveBtn.addEventListener('click', () => {
        ipcRenderer.send('account-switcher-save', {
            domain: profile.domain,
            account: profile.account,
            displayName: nameInput.value.trim() || profile.account,
            color: selectedColor
        });
        closePopover();
        onChanged();
    });

    btnRow.append(delBtn, saveBtn);
    pop.append(title, nameInput, swatchRow, btnRow);
    document.body.appendChild(pop);

    // 点击弹窗外部关闭
    setTimeout(() => {
        const closer = (e: MouseEvent) => {
            if (!pop.contains(e.target as Node)) {
                closePopover();
                document.removeEventListener('mousedown', closer);
            }
        };
        document.addEventListener('mousedown', closer);
    }, 0);
}

// “+” 弹窗：从登录历史添加账号
function openAddPopover(candidates: { domain: string; account: string }[], anchor: HTMLElement, onChanged: () => void, existingCount: number = 0): void {
    closePopover();
    const pop = document.createElement('div');
    pop.id = POPOVER_ID;

    const rect = anchor.getBoundingClientRect();
    pop.style.cssText = `
        position: fixed; top: ${rect.bottom + 6}px; right: ${window.innerWidth - rect.right}px;
        background: rgba(30, 32, 38, 0.96); color: #eee; border-radius: 10px;
        padding: 10px; width: 240px; max-height: 260px; overflow-y: auto; z-index: 100000;
        box-shadow: 0 8px 28px rgba(0,0,0,0.35); font-size: 13px;
        -webkit-app-region: no-drag;
    `;

    if (candidates.length === 0) {
        const empty = document.createElement('div');
        empty.textContent = '没有可添加的账号，请先在登录页登录';
        empty.style.cssText = 'opacity: 0.7; padding: 6px 4px;';
        pop.appendChild(empty);
    } else {
        candidates.forEach(c => {
            const row = document.createElement('div');
            row.textContent = `${c.account} @ ${c.domain}`;
            row.style.cssText = `
                padding: 7px 8px; border-radius: 6px; cursor: pointer; margin-bottom: 2px;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            `;
            row.addEventListener('mouseenter', () => row.style.background = 'rgba(255,255,255,0.1)');
            row.addEventListener('mouseleave', () => row.style.background = 'transparent');
            row.addEventListener('click', () => {
                ipcRenderer.send('account-switcher-save', {
                    domain: c.domain,
                    account: c.account,
                    displayName: c.account,
                    color: COLOR_PRESETS[(existingCount + candidates.indexOf(c)) % COLOR_PRESETS.length]
                });
                closePopover();
                onChanged();
            });
            pop.appendChild(row);
        });
    }

    document.body.appendChild(pop);
    setTimeout(() => {
        const closer = (e: MouseEvent) => {
            if (!pop.contains(e.target as Node)) {
                closePopover();
                document.removeEventListener('mousedown', closer);
            }
        };
        document.addEventListener('mousedown', closer);
    }, 0);
}

function rerender(): void {
    document.getElementById(CONTAINER_ID)?.remove();
    render();
}

async function render(): Promise<void> {
    const btns = document.getElementById('titlebar-btns');
    if (!btns) return;                      // 标题栏还没注入，等 OnDomChange 再试
    if (document.getElementById(CONTAINER_ID)) return; // 已渲染

    let data: AccountsData;
    try {
        data = await ipcRenderer.invoke('account-switcher-get');
    } catch (e) {
        logger.error('获取账号列表失败:', e);
        return;
    }
    if (!data || (data.profiles.length === 0 && data.candidates.length === 0)) return;
    // 异步返回时标题栏可能已被重建，二次确认
    if (!document.getElementById('titlebar-btns') || document.getElementById(CONTAINER_ID)) return;

    const container = document.createElement('div');
    container.id = CONTAINER_ID;
    container.style.cssText = `
        display: flex; gap: 4px; align-items: center;
        margin-right: 8px; -webkit-app-region: no-drag;
    `;

    for (const p of data.profiles) {
        const btn = document.createElement('button');
        const active = isActive(data, p);
        // 未选中的账号置灰，让当前账号更突出；悬停时恢复彩色提示可点击
        const idleFilter = active ? 'none' : 'grayscale(0.85) brightness(0.72)';
        const hoverFilter = active ? 'brightness(1.1)' : 'grayscale(0.15) brightness(1.05)';
        btn.style.cssText = `
            width: 22px; height: 22px; border-radius: 50%;
            background: ${p.color}; color: #fff; font-size: 12px; font-weight: 600;
            display: flex; align-items: center; justify-content: center;
            cursor: pointer; border: none; padding: 0;
            border: ${active ? '2px solid rgba(255,255,255,0.95)' : '2px solid transparent'};
            box-shadow: ${active ? '0 0 0 1.5px rgba(0,0,0,0.35)' : 'none'};
            filter: ${idleFilter};
            transition: transform 0.15s ease, filter 0.15s ease;
            font-family: -apple-system, "PingFang SC", sans-serif;
        `;
        btn.textContent = (p.displayName || p.account).trim().charAt(0).toUpperCase();
        btn.title = `${p.displayName}（${p.account}）${active ? ' · 当前' : ''}｜左键切换，右键编辑`;
        btn.addEventListener('mouseenter', () => { btn.style.filter = hoverFilter; btn.style.transform = 'scale(1.1)'; });
        btn.addEventListener('mouseleave', () => { btn.style.filter = idleFilter; btn.style.transform = 'scale(1)'; });
        btn.addEventListener('click', () => {
            if (active) return;
            ipcRenderer.send('account-switcher-switch', { domain: p.domain, account: p.account });
        });
        btn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openEditPopover(p, btn, rerender);
        });
        container.appendChild(btn);
    }

    // “+” 添加按钮
    const addBtn = document.createElement('button');
    addBtn.textContent = '+';
    addBtn.style.cssText = `
        width: 22px; height: 22px; border-radius: 50%;
        background: transparent; color: #888; font-size: 14px; line-height: 1;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; border: 1px dashed rgba(136,136,136,0.6); padding: 0;
        transition: all 0.15s ease;
    `;
    addBtn.title = '添加快速切换账号';
    addBtn.addEventListener('mouseenter', () => { addBtn.style.borderColor = '#bbb'; addBtn.style.color = '#ddd'; });
    addBtn.addEventListener('mouseleave', () => { addBtn.style.borderColor = 'rgba(136,136,136,0.6)'; addBtn.style.color = '#888'; });
    addBtn.addEventListener('click', () => openAddPopover(data.candidates, addBtn, rerender, data.profiles.length));
    container.appendChild(addBtn);

    // 插到窗口控制按钮（min/max/close）左侧
    btns.insertBefore(container, btns.firstChild);
}

registerHook(HookType.OnReady, render);
registerHook(HookType.OnDomChange, render);

export { };
