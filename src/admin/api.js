/**
 * 管理端 API 客户端：统一下单码鉴权、JSON 编解码、错误形状 {error:{code,message}}。
 * 401/403 时通过 onUnauthorized 回调清除凭据并回到统一登录页。
 */

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// 管理端调用路径已经带 /api/v1；生产前后端分离时只替换域名，避免重复拼接版本前缀。
const configuredBase = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const API_ORIGIN = configuredBase.endsWith('/api/v1')
  ? configuredBase.slice(0, -'/api/v1'.length)
  : configuredBase;

export function createApi({ getToken, getOrderCode, onUnauthorized }) {
  async function request(method, path, body) {
    const headers = {};
    const token = getToken?.();
    const orderCode = getOrderCode?.();
    if (orderCode) headers['X-Order-Code'] = encodeURIComponent(orderCode);
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetch(`${API_ORIGIN}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', '网络请求失败，请确认后端服务已启动');
    }

    if (res.status === 401 || res.status === 403) {
      onUnauthorized?.();
      throw new ApiError(res.status, 'UNAUTHORIZED', '管理员身份已失效，请重新登录');
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = data?.error ?? {};
      throw new ApiError(res.status, err.code ?? 'UNKNOWN', err.message ?? `请求失败（${res.status}）`);
    }
    return data;
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
    del: (path, body) => request('DELETE', path, body ?? {}),
  };
}
