#!/usr/bin/env node
/**
 * 创建云同步所需的 Dataverse 表：{prefix}_user / {prefix}_user_data / {prefix}_song。
 *
 * 用法：
 *   node scripts/create-dataverse-tables.mjs [--prefix jls] [--lcid 1033]
 *
 * 环境变量（必填）：
 *   DATAVERSE_TENANT_ID      Entra 租户 ID
 *   DATAVERSE_ENV_URL        Dataverse API 根，如 https://org.api.crm.dynamics.com
 *   DATAVERSE_CLIENT_ID      应用注册的 client id
 *   DATAVERSE_CLIENT_SECRET  应用密钥
 *
 * 前提：应用用户需临时具有「系统自定义员（System Customizer）」角色；
 * 建表完成后建议撤销该角色（详见 docs/cloud-setup.md）。
 *
 * 幂等：已存在的表 / 列 / 关系会跳过（缺失的列会补齐），可安全重复执行。
 *
 * 命名约定（与 Worker 端 schema() 一致，worker/src/cloud.js）：
 * - 表 / 列的 SchemaName 用帕斯卡大小写 + 下划线（如 jls_User_Data、jls_Password_Hash），
 *   逻辑名 = SchemaName 全小写（jls_user_data、jls_password_hash）；
 *   无下划线的驼峰 SchemaName 会生成无下划线的逻辑名，导致与 Worker 端不匹配。
 * - 实体集名显式声明（jls_users / jls_user_datas / jls_songs），不依赖自动复数化。
 * - 大 JSON 列用 Memo（多行文本，上限 1048576 字符）；自定义 String 列上限 4000。
 * - owner 查找列 SchemaName 为 {prefix}_Owner（帕斯卡）：OData 导航属性名保留该大小写
 *   （jls_Owner@odata.bind），过滤用结构属性 _jls_owner_value（小写）。
 */

// ---------------------------------------------------------------- 参数

const rawArgs = process.argv.slice(2);
function argValue(name, fallback) {
  const flag = `--${name}`;
  const i = rawArgs.indexOf(flag);
  if (i >= 0 && i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('--')) return rawArgs[i + 1];
  const eq = rawArgs.find((a) => a.startsWith(`${flag}=`));
  if (eq) return eq.slice(flag.length + 1);
  return fallback;
}

const PREFIX = String(argValue('prefix', process.env.DATAVERSE_PREFIX || 'jls')).toLowerCase();
const LCID = Number(argValue('lcid', '1033')) || 1033;
const TENANT = process.env.DATAVERSE_TENANT_ID;
const ENV_URL = String(process.env.DATAVERSE_ENV_URL || '').replace(/\/+$/, '');
const CLIENT_ID = process.env.DATAVERSE_CLIENT_ID;
const CLIENT_SECRET = process.env.DATAVERSE_CLIENT_SECRET;

if (!TENANT || !ENV_URL || !CLIENT_ID || !CLIENT_SECRET) {
  console.error('缺少环境变量：DATAVERSE_TENANT_ID / DATAVERSE_ENV_URL / DATAVERSE_CLIENT_ID / DATAVERSE_CLIENT_SECRET');
  console.error('配置说明见 docs/cloud-setup.md。');
  process.exit(1);
}

const API = `${ENV_URL}/api/data/v9.2`;
const P = PREFIX;

// ---------------------------------------------------------------- Dataverse 访问

let token = null;
let tokenExp = 0;

async function getToken() {
  if (token && Date.now() < tokenExp - 60_000) return token;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: `${ENV_URL}/.default`,
  });
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`获取访问令牌失败：${data.error_description || res.status}`);
  token = data.access_token;
  tokenExp = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  return token;
}

async function api(path, { method = 'GET', body, allow404 = false } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && allow404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} 失败（${res.status}）：${text.slice(0, 500)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------------------------------------------------------------- 元数据构造

function label(text) {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.Label',
    LocalizedLabels: [
      { '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel', Label: text, LanguageCode: LCID },
    ],
  };
}

function requiredLevel(value) {
  return { Value: value, CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' };
}

function stringAttr(schemaName, displayName, maxLength, { format = 'Text', required = 'None', primary = false, description = '' } = {}) {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    AttributeType: 'String',
    AttributeTypeName: { Value: 'StringType' },
    SchemaName: schemaName,
    DisplayName: label(displayName),
    Description: label(description),
    MaxLength: maxLength,
    FormatName: { Value: format },
    RequiredLevel: requiredLevel(required),
    ...(primary ? { IsPrimaryName: true } : {}),
  };
}

function intAttr(schemaName, displayName, { required = 'None' } = {}) {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata',
    AttributeType: 'Integer',
    AttributeTypeName: { Value: 'IntegerType' },
    SchemaName: schemaName,
    DisplayName: label(displayName),
    Description: label(''),
    MaxValue: 2147483647,
    MinValue: 0,
    RequiredLevel: requiredLevel(required),
  };
}

/**
 * 多行文本（Memo）列：自定义 String 列上限 4000 字符（与格式无关，超限报 0x80090479），
 * 大 JSON 载荷必须用 Memo，上限 1048576 字符。
 */
function memoAttr(schemaName, displayName, maxLength, { required = 'None', description = '' } = {}) {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.MemoAttributeMetadata',
    AttributeType: 'Memo',
    AttributeTypeName: { Value: 'MemoType' },
    SchemaName: schemaName,
    DisplayName: label(displayName),
    Description: label(description),
    MaxLength: maxLength,
    FormatName: { Value: 'TextArea' },
    RequiredLevel: requiredLevel(required),
  };
}

function tableDef({ schemaName, entitySetName, displayName, collectionName, description, attributes }) {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
    SchemaName: schemaName,
    // 显式实体集名，与 Worker 端 setName()（逻辑名 + 's'）一致，避免自动复数化意外
    EntitySetName: entitySetName,
    DisplayName: label(displayName),
    DisplayCollectionName: label(collectionName),
    Description: label(description),
    OwnershipType: 'UserOwned',
    IsActivity: false,
    HasActivities: false,
    HasNotes: false,
    Attributes: attributes,
  };
}

/** 引用表 → {prefix}_user 的查找列（owner），删除账号时级联删除数据。 */
function ownerRelationship(referencingTable) {
  const relSchema = `${P}_user_${referencingTable}`;
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata',
    SchemaName: relSchema,
    ReferencedEntity: `${P}_user`,
    ReferencedAttribute: `${P}_userid`,
    ReferencingEntity: referencingTable,
    CascadeConfiguration: {
      Assign: 'NoCascade',
      Delete: 'Cascade',
      Merge: 'NoCascade',
      Reparent: 'NoCascade',
      Share: 'NoCascade',
      Unshare: 'NoCascade',
    },
    Lookup: {
      '@odata.type': 'Microsoft.Dynamics.CRM.LookupAttributeMetadata',
      AttributeType: 'Lookup',
      AttributeTypeName: { Value: 'LookupType' },
      SchemaName: `${P}_Owner`,
      DisplayName: label('JLS Account'),
      Description: label('Owner cloud account'),
      RequiredLevel: requiredLevel('ApplicationRequired'),
    },
  };
}

// ---------------------------------------------------------------- 幂等检查

async function tableExists(logical) {
  const data = await api(`/EntityDefinitions(LogicalName='${logical}')?$select=LogicalName`, { allow404: true });
  return Boolean(data);
}

async function columnExists(tableLogical, columnLogical) {
  const data = await api(
    `/EntityDefinitions(LogicalName='${tableLogical}')/Attributes?$filter=LogicalName eq '${columnLogical}'&$select=LogicalName`
  );
  return (data?.value || []).length > 0;
}

async function relationshipExists(schemaName) {
  const data = await api(`/RelationshipDefinitions?$filter=SchemaName eq '${schemaName}'&$select=SchemaName`);
  return (data?.value || []).length > 0;
}

async function ensureTable(def) {
  const logical = def.SchemaName.toLowerCase();
  if (await tableExists(logical)) {
    console.log(`表 ${logical} 已存在，跳过创建`);
    for (const attr of def.Attributes) {
      if (attr.IsPrimaryName) continue; // 主名列随表创建，必然存在
      const colLogical = attr.SchemaName.toLowerCase();
      if (!(await columnExists(logical, colLogical))) {
        await api(`/EntityDefinitions(LogicalName='${logical}')/Attributes`, { method: 'POST', body: attr });
        console.log(`  已补齐列 ${colLogical}`);
      }
    }
    return;
  }
  await api('/EntityDefinitions', { method: 'POST', body: def });
  console.log(`已创建表 ${logical}（实体集 ${def.EntitySetName}）`);
}

async function ensureRelationship(def) {
  if (await relationshipExists(def.SchemaName)) {
    console.log(`关系 ${def.SchemaName} 已存在，跳过创建`);
    return;
  }
  await api('/RelationshipDefinitions', { method: 'POST', body: def });
  console.log(`已创建关系 ${def.SchemaName}（查找列 ${def.Lookup.SchemaName.toLowerCase()}）`);
}

// ---------------------------------------------------------------- 主流程

const MAX_JSON = 1048576; // Dataverse 多行文本列上限（字符）

async function main() {
  console.log(`目标环境：${ENV_URL}（前缀 ${P}，标签语言 ${LCID}）`);

  // 1. 账号表
  await ensureTable(
    tableDef({
      schemaName: `${P}_User`,
      entitySetName: `${P}_users`,
      displayName: 'JLS User',
      collectionName: 'JLS Users',
      description: 'JP Lyrics Studio cloud sync accounts',
      attributes: [
        stringAttr(`${P}_Username`, 'Username', 32, { required: 'ApplicationRequired', primary: true }),
        stringAttr(`${P}_Email`, 'Email', 254),
        stringAttr(`${P}_Password_Hash`, 'Password Hash', 512),
        stringAttr(`${P}_Salt`, 'Salt', 64),
        intAttr(`${P}_Iterations`, 'PBKDF2 Iterations'),
      ],
    })
  );

  // 2. 用户数据表（config + dictionary，每账号一行）
  await ensureTable(
    tableDef({
      schemaName: `${P}_User_Data`,
      entitySetName: `${P}_user_datas`,
      displayName: 'JLS User Data',
      collectionName: 'JLS User Data',
      description: 'Per-account config and dictionary JSON',
      attributes: [
        stringAttr(`${P}_Name`, 'Name', 100, { primary: true }),
        memoAttr(`${P}_Config_Json`, 'Config JSON', MAX_JSON),
        memoAttr(`${P}_Dictionary_Json`, 'Dictionary JSON', MAX_JSON),
        stringAttr(`${P}_Updated_At`, 'Updated At', 32),
      ],
    })
  );
  await ensureRelationship(ownerRelationship(`${P}_user_data`));

  // 3. 歌曲表
  await ensureTable(
    tableDef({
      schemaName: `${P}_Song`,
      entitySetName: `${P}_songs`,
      displayName: 'JLS Song',
      collectionName: 'JLS Songs',
      description: 'Per-account synced songs (lyric JSON + metadata)',
      attributes: [
        stringAttr(`${P}_Title`, 'Title', 200, { primary: true }),
        stringAttr(`${P}_Song_Id`, 'Song ID', 64, { required: 'ApplicationRequired' }),
        stringAttr(`${P}_Artist`, 'Artist', 200),
        stringAttr(`${P}_Badges`, 'Badges JSON', 4000),
        memoAttr(`${P}_Lyric_Json`, 'Lyric JSON', MAX_JSON),
        stringAttr(`${P}_Audio_Path`, 'Audio Path', 400),
        stringAttr(`${P}_Updated_At`, 'Updated At', 32),
      ],
    })
  );
  await ensureRelationship(ownerRelationship(`${P}_song`));

  console.log('\n完成。后续步骤：');
  console.log('  1. 给应用用户分配访问这些表的安全角色（见 docs/cloud-setup.md）');
  console.log('  2. 撤销应用用户的「系统自定义员」角色');
  console.log('  3. 在 Worker 上配置 wrangler secrets / vars 并部署');
  console.log('  4. 打开前端页面，注册账号验证云同步');
}

main().catch((err) => {
  console.error(`\n执行失败：${err.message}`);
  process.exit(1);
});
