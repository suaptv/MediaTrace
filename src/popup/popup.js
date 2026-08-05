import { formatDuration } from "../core/media.js";
const api = globalThis.browser ?? globalThis.chrome;
const list = document.querySelector("#list");
const summary = document.querySelector("#summary");
const template = document.querySelector("#row");
const enabledInput = document.querySelector("#enabled");
const clearDialog = document.querySelector("#clear-dialog");
const deviceList = document.querySelector("#device-list");
const connectedList = document.querySelector("#connected-list");
const dlnaStatus = document.querySelector("#dlna-status");
const rememberInput = document.querySelector("#remember-device");
const autoCastNextInput = document.querySelector("#auto-cast-next");
const toast = document.querySelector("#toast");
const airplayHelper = document.querySelector("#airplay-helper");
const airplayHelperList = document.querySelector("#airplay-helper-list");
let tabId;
let refreshTimer;
let toastTimer;
const DEFAULT_DLNA_STATE = { dlnaDevices: [], dlnaRememberDevice: true, dlnaSelectedDeviceId: null, dlnaConnectedDeviceIds: [], dlnaAutoCastNext: false,
  castDeviceType: "dlna", airplayDevices: [], airplaySelectedDeviceId: null };
let dlnaState = { ...DEFAULT_DLNA_STATE };

function normalizeDlnaState(value) {
  return {
    ...DEFAULT_DLNA_STATE,
    ...(value && typeof value === "object" ? value : {}),
    castDeviceType: value?.castDeviceType === "airplay" ? "airplay" : "dlna",
    dlnaDevices: Array.isArray(value?.dlnaDevices) ? value.dlnaDevices : [],
    airplayDevices: Array.isArray(value?.airplayDevices) ? value.airplayDevices : [],
    dlnaConnectedDeviceIds: Array.isArray(value?.dlnaConnectedDeviceIds) ? value.dlnaConnectedDeviceIds : []
  };
}

function showToast(title, message, type = "success") {
  clearTimeout(toastTimer);
  toast.className = `toast ${type}`;
  toast.querySelector("strong").textContent = title;
  toast.querySelector("span").textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3200);
}

function statusText(item) {
  if (item.status === "loading") return "正在读取元数据…";
  if (item.status === "error") return `读取失败：${item.error}`;
  if (item.kind === "stream") return `已归组 ${item.segmentCount} 个媒体分片`;
  if (item.kind === "m4s") {
    const track = item.mediaTrack === "audio" ? "音频轨" : item.mediaTrack === "video" ? "视频轨" : "媒体轨";
    const resolution = item.resolution?.width > 0 && item.resolution?.height > 0 ? ` · ${item.resolution.width}×${item.resolution.height}` : "";
    return `B站 DASH · ${track}${resolution}`;
  }
  if (item.kind === "youtube") return `YouTube 点播 · ${item.mediaTrack === "muxed" ? "音视频合并" : item.mediaTrack === "audio" ? "音频轨" : item.mediaTrack === "video" ? "视频轨" : "媒体轨"}`;
  if (item.kind === "flv") return `${item.streamType === "live" ? "直播" : "点播"} · 已读取 ${(item.bytesRead / 1024).toFixed(0)} KB 片头`;
  if (item.kind === "m3u8") return item.streamType === "live" ? "HLS 直播" : item.streamType === "vod" ? "HLS 点播" : "HLS 播放列表已解析";
  if (item.kind === "mp4" && item.bytesRead) return `已读取 ${(item.bytesRead / 1024).toFixed(0)} KB 元数据`;
  return item.duration == null ? "未找到时长" : "播放列表已解析";
}

function showPanel(name) {
  const media = name === "media";
  const dlna = name === "dlna";
  document.querySelector("#media-panel").hidden = !media;
  document.querySelector("#dlna-panel").hidden = !dlna;
  document.querySelector("#connected-panel").hidden = name !== "connected";
  document.querySelector("#media-tab").classList.toggle("active", media);
  document.querySelector("#dlna-tab").classList.toggle("active", !media);
}

async function cast(item, button) {
  if (!dlnaState.dlnaSelectedDeviceId) {
    showPanel("dlna");
    dlnaStatus.textContent = "请先选择投屏设备";
    showToast("请选择设备", "请先选择一个 DLNA 设备", "warning");
    return;
  }
  button.disabled = true; button.textContent = "连接中…";
  const response = await api.runtime.sendMessage({ type: "CAST_DLNA", tabId, mediaId: item.id, deviceId: dlnaState.dlnaSelectedDeviceId });
  button.disabled = false;
  if (response?.error) { button.textContent = "重试"; dlnaStatus.textContent = response.error; showToast("投屏失败", response.error, "error"); return; }
  dlnaState.dlnaSelectedDeviceId = response.deviceId;
  if (!dlnaState.dlnaConnectedDeviceIds.includes(response.deviceId)) dlnaState.dlnaConnectedDeviceIds.push(response.deviceId);
  button.textContent = "已投屏";
  showToast("已发送到设备", "DLNA 播放指令已发送");
}

function render(items) {
  list.replaceChildren(); summary.textContent = `发现 ${items.length} 个媒体资源`;
  if (!items.length) { list.innerHTML = '<div class="empty">暂未发现媒体流<br><small>请先播放视频，然后重新打开面板</small></div>'; return; }
  for (const item of items) {
    const node = template.content.cloneNode(true);
    node.querySelector(".badge").textContent = item.kind.toUpperCase();
    node.querySelector(".badge").classList.add(item.kind);
    node.querySelector(".duration").textContent = item.resolution?.width > 0 && item.resolution?.height > 0
      ? `${item.resolution.width}×${item.resolution.height}`
      : item.streamType === "live" ? "直播" : formatDuration(item.duration);
    node.querySelector(".domain").textContent = item.domain;
    node.querySelector(".url").textContent = item.url;
    node.querySelector(".status").textContent = statusText(item);
    node.querySelector(".copy").addEventListener("click", async (event) => {
      await navigator.clipboard.writeText(item.url); event.currentTarget.textContent = "已复制";
    });
    node.querySelector(".cast").addEventListener("click", (event) => cast(item, event.currentTarget).catch((error) => {
      event.currentTarget.disabled = false; event.currentTarget.textContent = "重试"; dlnaStatus.textContent = error.message;
    }));
    list.append(node);
  }
}

function renderDevices() {
  dlnaState = normalizeDlnaState(dlnaState);
  rememberInput.checked = dlnaState.dlnaRememberDevice;
  autoCastNextInput.checked = dlnaState.dlnaAutoCastNext;
  deviceList.replaceChildren();
  const devices = dlnaState.dlnaDevices;
  if (!devices.length) {
    deviceList.innerHTML = '<div class="empty compact">没有设备，请点击“刷新搜索”</div>'; return;
  }
  for (const device of devices) {
    const row = document.createElement("div"); row.className = "device-row discovery-row";
    const select = document.createElement("button"); select.className = "device-select";
    select.innerHTML = `<strong></strong><small></small>`;
    select.querySelector("strong").textContent = device.name || "DLNA 设备";
    select.querySelector("small").textContent = device.host || new URL(device.controlURL).host;
    if (device.id === dlnaState.dlnaSelectedDeviceId) select.classList.add("selected");
    select.addEventListener("click", async () => {
      dlnaState.dlnaSelectedDeviceId = device.id; renderDevices();
      await api.runtime.sendMessage({ type: "SAVE_DLNA_SETTINGS", remember: rememberInput.checked,
        selectedId: device.id, activeDeviceId: device.id, autoCastNext: autoCastNextInput.checked });
    });
    row.append(select); deviceList.append(row);
  }
}

function renderConnectedDevices() {
  connectedList.replaceChildren();
  const connectedIds = new Set(dlnaState.dlnaConnectedDeviceIds);
  const devices = dlnaState.dlnaDevices.filter((device) => connectedIds.has(device.id));
  if (!devices.length) {
    connectedList.innerHTML = '<div class="empty compact">尚无连接成功的设备<br><small>首次投屏成功后会显示在这里</small></div>';
  } else for (const device of devices) {
    const row = document.createElement("div"); row.className = "device-row";
    const info = document.createElement("div"); info.className = "connected-device-info";
    info.innerHTML = "<strong></strong><small></small>";
    info.querySelector("strong").textContent = device.name || "DLNA 设备";
    info.querySelector("small").textContent = device.host || new URL(device.controlURL).host;
    const remove = document.createElement("button"); remove.className = "remove-device"; remove.textContent = "删除";
    remove.addEventListener("click", async () => {
      const response = await api.runtime.sendMessage({ type: "REMOVE_DLNA_DEVICE", deviceId: device.id });
      dlnaState.dlnaDevices = Array.isArray(response?.devices) ? response.devices : [];
      dlnaState.dlnaConnectedDeviceIds = dlnaState.dlnaConnectedDeviceIds.filter((id) => id !== device.id);
      if (dlnaState.dlnaSelectedDeviceId === device.id) dlnaState.dlnaSelectedDeviceId = null;
      renderConnectedDevices(); renderDevices();
    });
    row.append(info, remove); connectedList.append(row);
  }
}

async function loadDlna() {
  // Read settings directly in the popup. Safari can briefly return undefined
  // for a message sent while its background page is being relaunched.
  const response = await api.storage.local.get(DEFAULT_DLNA_STATE);
  dlnaState = normalizeDlnaState(response);
  renderDevices();
  renderConnectedDevices();
}

async function load() {
  clearTimeout(refreshTimer);
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  const storedState = await api.storage.local.get({ detectionEnabled: false });
  const detectionEnabled = Boolean(storedState?.detectionEnabled);
  enabledInput.checked = detectionEnabled;
  if (!detectionEnabled) {
    summary.textContent = "检测功能已关闭";
    list.innerHTML = '<div class="empty">打开“自动检测”后，扩展会监测 M3U8、MP4、FLV、M4S 和分片流</div>'; return;
  }
  const response = await api.runtime.sendMessage({ type: "GET_MEDIA", tabId });
  const items = Array.isArray(response?.items) ? response.items : [];
  render(items);
  if (!response) summary.textContent = "检测后台正在重新载入";
  if (items.some((item) => item.status === "loading")) refreshTimer = setTimeout(() => load().catch(() => {}), 500);
}

document.querySelector("#media-tab").addEventListener("click", () => showPanel("media"));
document.querySelector("#dlna-tab").addEventListener("click", () => showPanel("dlna"));
document.querySelector("#connected-devices").addEventListener("click", () => { renderConnectedDevices(); showPanel("connected"); });
document.querySelector("#back-to-devices").addEventListener("click", () => showPanel("dlna"));
document.querySelector("#find-airplay-address").addEventListener("click", async (event) => {
  const button = event.currentTarget; button.disabled = true; button.textContent = "搜索中…";
  airplayHelper.hidden = false; airplayHelperList.innerHTML = '<div class="empty compact">正在通过 Bonjour 搜索…</div>';
  const response = await api.runtime.sendMessage({ type: "DISCOVER_AIRPLAY" }).catch((error) => ({ error: error.message }));
  button.disabled = false; button.textContent = "从 AirPlay 查找 .local 地址"; airplayHelperList.replaceChildren();
  if (!response || response.error) {
    airplayHelperList.innerHTML = '<div class="empty compact">搜索失败</div>';
    showToast("地址搜索失败", response?.error || "原生服务没有响应", "error"); return;
  }
  const devices = Array.isArray(response.airplayDevices) ? response.airplayDevices : [];
  if (!devices.length) airplayHelperList.innerHTML = '<div class="empty compact">没有发现 AirPlay 广播</div>';
  for (const device of devices) {
    const choice = document.createElement("button"); choice.className = "airplay-device";
    choice.innerHTML = "<strong></strong><small></small>";
    choice.querySelector("strong").textContent = device.name || "Bonjour 设备";
    choice.querySelector("small").textContent = device.host || "未解析主机名";
    choice.addEventListener("click", () => {
      const addressInput = document.querySelector("#device-control-url");
      try {
        const current = new URL(addressInput.value); current.hostname = device.host;
        if (!current.port) current.port = "9030";
        addressInput.value = current.href;
      }
      catch { addressInput.value = `http://${device.host}:9030/description.xml`; }
      const nameInput = document.querySelector("#device-name"); if (!nameInput.value) nameInput.value = device.name || "DLNA 设备";
      airplayHelper.hidden = true; showToast("已填入稳定地址", `${device.host}；请确认 DLNA 端口和路径后添加`);
    });
    airplayHelperList.append(choice);
  }
});
document.querySelector("#refresh-devices").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true; button.textContent = "搜索中…"; dlnaStatus.textContent = "正在搜索局域网设备…";
  const response = await api.runtime.sendMessage({ type: "DISCOVER_DLNA" }).catch((error) => ({ error: error.message }));
  button.disabled = false; button.textContent = "刷新搜索";
  if (!response || response.error) {
    const message = response?.error || "设备搜索后台无响应，请重新打开面板";
    dlnaStatus.textContent = "搜索失败"; showToast("搜索失败", message, "error"); return;
  }
  dlnaState = normalizeDlnaState({ ...dlnaState, ...response }); renderDevices();
  const count = dlnaState.dlnaDevices.length;
  dlnaStatus.textContent = `搜索完成 · ${count} 个设备`;
  showToast("搜索完成", count ? `发现 ${count} 个可用的 DLNA 设备` : "未发现可用设备，请确认设备位于同一局域网", count ? "success" : "warning");
});
rememberInput.addEventListener("change", async () => {
  dlnaState.dlnaRememberDevice = rememberInput.checked;
  if (!rememberInput.checked) dlnaState.dlnaSelectedDeviceId = null;
  await api.runtime.sendMessage({ type: "SAVE_DLNA_SETTINGS", remember: rememberInput.checked,
    selectedId: dlnaState.dlnaSelectedDeviceId, activeDeviceId: dlnaState.dlnaSelectedDeviceId,
    autoCastNext: autoCastNextInput.checked }); renderDevices();
});
autoCastNextInput.addEventListener("change", async () => {
  if (autoCastNextInput.checked && !dlnaState.dlnaSelectedDeviceId) {
    autoCastNextInput.checked = false;
    showToast("请先选择设备", "选择一个 DLNA 服务器后再开启自动投屏", "warning");
    return;
  }
  dlnaState.dlnaAutoCastNext = autoCastNextInput.checked;
  await api.runtime.sendMessage({ type: "SAVE_DLNA_SETTINGS", remember: rememberInput.checked,
    selectedId: dlnaState.dlnaSelectedDeviceId, activeDeviceId: dlnaState.dlnaSelectedDeviceId,
    autoCastNext: autoCastNextInput.checked });
  if (autoCastNextInput.checked) {
    await api.runtime.sendMessage({ type: "TRIGGER_AUTO_CAST", tabId });
    showToast("自动投屏已开启", "当前视频和之后检测到的新视频将投到所选设备");
  }
});
document.querySelector("#add-device-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true; submit.textContent = "解析中…";
  const controlURL = document.querySelector("#device-control-url").value.trim();
  const response = await api.runtime.sendMessage({ type: "ADD_DLNA_DEVICE", device: { name: document.querySelector("#device-name").value.trim(), controlURL } })
    .catch((error) => ({ error: error.message }));
  submit.disabled = false; submit.textContent = "添加";
  if (!response || response.error) {
    const message = response?.error || "DLNA 后台无响应";
    dlnaStatus.textContent = message; showToast("添加失败", message, "error"); return;
  }
  const returnedDevices = Array.isArray(response.devices) ? response.devices : [];
  const addedDevice = response.device && typeof response.device === "object" ? response.device : null;
  const immediateDevices = addedDevice
    ? [...dlnaState.dlnaDevices.filter((device) => device.id !== addedDevice.id), addedDevice]
    : returnedDevices;
  dlnaState = normalizeDlnaState({ ...dlnaState, dlnaDevices: immediateDevices });
  // Render from the returned device itself first. Safari may briefly expose a
  // stale storage snapshot while the popup remains open.
  renderDevices();
  event.currentTarget.reset(); event.currentTarget.closest("details").open = false;
  dlnaStatus.textContent = `已添加 · ${response.device?.name || "DLNA 设备"}`;
  showToast("设备已添加", response.device?.controlURL || "设备列表已刷新");
});
enabledInput.addEventListener("change", async () => {
  enabledInput.disabled = true;
  await api.storage.local.set({ detectionEnabled: enabledInput.checked });
  await api.runtime.sendMessage({ type: "SET_ENABLED", enabled: enabledInput.checked, tabId }).catch(() => undefined);
  enabledInput.disabled = false; await load();
});
document.querySelector("#clear").addEventListener("click", () => clearDialog.showModal());
clearDialog.addEventListener("click", (event) => { if (event.target === clearDialog) clearDialog.close("cancel"); });
clearDialog.addEventListener("close", async () => {
  if (clearDialog.returnValue !== "confirm") return;
  await api.runtime.sendMessage({ type: "CLEAR_MEDIA", tabId }); render([]);
});
Promise.all([load(), loadDlna()]).catch((error) => { summary.textContent = "读取失败"; list.textContent = error.message; });
