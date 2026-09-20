import { api } from './api'

// 购物车草稿的服务端 API 适配器：草稿关联下单码用户，凭码跨设备恢复。
//
// payload v2 结构（2026-09-19 起）：
//   { version: 2, packaging: 'gift'|'plain', configs: [...], addresses: [...] }
//   · configs 是「配置清单」：套餐模板或自定义搭配，同一份搭配只存一条
//   · packaging 是整车统一的包装（礼盒 / 普通）
//   · addresses 每条都挂一个 configId，一条地址就是一套（不再有份数字段）
// payload v1（{ version: 1, selection, addresses[] }）仍能读入，读的时候降级为一条配置。

export function emptyCartAddresses() {
  return [{ id: `address-${Date.now()}`, name: '', phone: '', address: '', configId: null }]
}

export function buildDraftPayload(configs, packaging, addresses) {
  return {
    version: 2,
    packaging: packaging === 'gift' ? 'gift' : 'plain',
    configs: (configs ?? []).map((entry) => ({
      id: entry.id,
      label: entry.label ?? '',
      mode: entry.mode === 'template' ? 'template' : 'custom',
      templateId: entry.templateId ?? null,
      items: entry.items ?? {},
    })),
    addresses: (addresses ?? []).map((entry) => ({
      name: entry.name ?? '',
      phone: entry.phone ?? '',
      address: entry.address ?? '',
      configId: entry.configId ?? null,
    })),
  }
}

// 读取草稿：把两种版本的 payload 统一成 v2 形状，调用方不用关心是老草稿还是新草稿。
export function readDraftPayload(payload) {
  const source = payload ?? {}
  const configs = Array.isArray(source.configs) && source.configs.length
    ? source.configs.map((entry, index) => ({
      id: entry.id ?? `cfg-${index}`,
      label: entry.label ?? '',
      mode: entry.mode === 'template' ? 'template' : 'custom',
      templateId: entry.templateId ?? null,
      items: entry.items ?? {},
    }))
    : source.selection
      ? [{
        id: source.selection.id ?? 'legacy',
        label: '',
        mode: source.selection.mode === 'template' ? 'template' : 'custom',
        templateId: source.selection.templateId ?? null,
        items: source.selection.items ?? {},
      }]
      : []
  const firstId = configs[0]?.id ?? null
  const addresses = (Array.isArray(source.addresses) ? source.addresses : []).map((entry, index) => ({
    id: entry.id ?? `address-${index}-${Date.now()}`,
    name: entry.name ?? '',
    phone: entry.phone ?? '',
    address: entry.address ?? '',
    configId: entry.configId ?? firstId,
  }))
  return {
    packaging: source.packaging === 'plain' ? 'plain' : 'gift',
    configs,
    addresses,
  }
}

export async function listDrafts() {
  const data = await api.listCartDrafts()
  return data?.drafts ?? []
}

export async function createDraft(configs, packaging, addresses) {
  const data = await api.createCartDraft(buildDraftPayload(configs, packaging, addresses))
  return data?.draft ?? null
}

export async function updateDraft(id, configs, packaging, addresses) {
  const data = await api.updateCartDraft(id, buildDraftPayload(configs, packaging, addresses))
  return data?.draft ?? null
}

export async function deleteDraft(id) {
  await api.deleteCartDraft(id)
}
