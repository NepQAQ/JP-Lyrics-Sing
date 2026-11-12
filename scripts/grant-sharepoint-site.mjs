#!/usr/bin/env node
/**
 * 授予应用对指定 SharePoint 站点的访问权限（Sites.Selected 场景），并打印
 * 站点 ID / 文档库 ID，供 Worker 的 SHAREPOINT_SITE_ID / SHAREPOINT_DRIVE_ID 使用。
 *
 * 用法：
 *   node scripts/grant-sharepoint-site.mjs --site "contoso.sharepoint.com:/sites/JLS" [--drive 文档] [--revoke]
 *
 *   --site   站点定位符：{主机}:/sites/{路径}（也可直接传站点 ID）
 *   --drive  要显示 ID 的文档库名称（默认列出全部）
 *   --revoke 删除已授予的应用权限（传入权限 ID；不带 ID 时先列出）
 *
 * 环境变量（必填）：DATAVERSE_TENANT_ID / DATAVERSE_CLIENT_ID / DATAVERSE_CLIENT_SECRET
 *
 * 前提：应用注册需临时具有 Graph「Sites.FullControl.All」应用程序权限并已管理员同意
 * （授权完成后请移除该权限，仅保留 Sites.Selected）。详见 docs/cloud-setup.md。
 */

const rawArgs = process.argv.slice(2);
function flagValue(name) {
  const flag = `--${name}`;
  const i = rawArgs.indexOf(flag);
  if (i >= 0 && i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('--')) return rawArgs[i + 1];
  const eq = rawArgs.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

const TENANT = process.env.DATAVERSE_TENANT_ID;
const CLIENT_ID = process.env.DATAVERSE_CLIENT_ID;
const CLIENT_SECRET = process.env.DATAVERSE_CLIENT_SECRET;
const SITE = flagValue('site');
const DRIVE = flagValue('drive');
const REVOKE = rawArgs.includes('--revoke');

if (!TENANT || !CLIENT_ID || !CLIENT_SECRET || (!SITE && !REVOKE)) {
  console.error('用法：node scripts/grant-sharepoint-site.mjs --site "contoso.sharepoint.com:/sites/JLS" [--drive 文档] [--revoke]');
  console.error('环境变量：DATAVERSE_TENANT_ID / DATAVERSE_CLIENT_ID / DATAVERSE_CLIENT_SECRET');
  process.exit(1);
}

async function getToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
  });
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`获取 Graph 令牌失败：${data.error_description || res.status}`);
  return data.access_token;
}

async function graph(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} 失败（${res.status}）：${JSON.stringify(data.error || data).slice(0, 400)}`);
  return data;
}

async function main() {
  // 1. 解析站点 ID
  let siteId = SITE;
  if (SITE && !/^[0-9a-f-]{36},[0-9a-f-]{36}$/i.test(SITE)) {
    const site = await graph(`/sites/${SITE}`);
    siteId = site.id;
    console.log(`站点：${site.displayName}（${site.webUrl}）`);
    console.log(`  SHAREPOINT_SITE_ID = ${siteId}`);
  }

  // 2. 列出 / 授予 / 撤销应用权限
  const perms = (await graph(`/sites/${siteId}/permissions`)).value || [];
  const mine = perms.filter((p) => p.grantedToIdentities?.some((g) => g.application?.id === CLIENT_ID));

  if (REVOKE) {
    if (mine.length === 0) {
      console.log('该应用在此站点没有已授予的权限。');
      return;
    }
    for (const p of mine) {
      await graph(`/sites/${siteId}/permissions/${p.id}`, { method: 'DELETE' });
      console.log(`已撤销权限 ${p.id}（roles: ${(p.roles || []).join(', ')}）`);
    }
    return;
  }

  if (mine.length > 0) {
    console.log(`应用已具有站点权限（roles: ${(mine[0].roles || []).join(', ')}），跳过重复授权。`);
  } else {
    await graph(`/sites/${siteId}/permissions`, {
      method: 'POST',
      body: {
        roles: ['write'],
        grantedToIdentities: [
          { application: { id: CLIENT_ID, displayName: 'JLS Cloud Sync' } },
        ],
      },
    });
    console.log('已授予应用站点「write」权限（可读写站点内文件）。');
  }

  // 3. 列出文档库
  const drives = (await graph(`/sites/${siteId}/drives`)).value || [];
  const target = DRIVE ? drives.filter((d) => d.name === DRIVE) : drives;
  if (target.length === 0) {
    console.log(`\n未找到名为「${DRIVE}」的文档库。站点现有文档库：`);
  }
  console.log('\n文档库（任选其一作为 SHAREPOINT_DRIVE_ID）：');
  for (const d of target.length ? target : drives) {
    console.log(`  ${d.name.padEnd(20)} SHAREPOINT_DRIVE_ID = ${d.id}`);
  }
  console.log('\n音频将存放在所选文档库的 Songs/{userId}/{songId} 路径下。');
}

main().catch((err) => {
  console.error(`执行失败：${err.message}`);
  process.exit(1);
});
