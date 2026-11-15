import { getSettings, saveSettings } from "./settings.js";

const hostField = document.querySelector("#host");
const codeField = document.querySelector("#accessCode");
const status = document.querySelector("#status");

const { host, accessCode } = await getSettings();
hostField.value = host;
codeField.value = accessCode;

document.querySelector("#save").addEventListener("click", async () => {
  await saveSettings({ host: hostField.value.trim(), accessCode: codeField.value });
  status.textContent = "Saved.";
  setTimeout(() => { status.textContent = ""; }, 2000);
});
