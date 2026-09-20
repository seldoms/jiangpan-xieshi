const BASE = '/api/v1';

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 204) return null;
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const err = new Error(data?.error?.message || `请求失败（${response.status}）`);
    err.code = data?.error?.code || null;
    err.status = response.status;
    throw err;
  }
  return data;
}

export const fetchGroup = (token) => request(`/groups/${encodeURIComponent(token)}`);

export const fetchGroupAmount = (token) => request(`/groups/${encodeURIComponent(token)}/amount`);

export const fetchCurrentConfig = () => request('/config/current');

export const addMember = (token, payload) =>
  request(`/groups/${encodeURIComponent(token)}/members`, { method: 'POST', body: payload });

export const updateMember = (token, memberId, payload, editKey) =>
  request(`/groups/${encodeURIComponent(token)}/members/${memberId}`, {
    method: 'PUT',
    body: payload,
    headers: { 'X-Edit-Key': editKey },
  });

export const deleteMember = (token, memberId, editKey) =>
  request(`/groups/${encodeURIComponent(token)}/members/${memberId}`, {
    method: 'DELETE',
    headers: { 'X-Edit-Key': editKey },
  });

export const submitGroup = (token, payload, orderCode) =>
  request(`/groups/${encodeURIComponent(token)}/submit`, {
    method: 'POST',
    body: payload,
    headers: { 'X-Order-Code': encodeURIComponent(orderCode) },
  });
