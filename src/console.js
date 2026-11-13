import "@ui-sdk/web/field"
import "@ui-sdk/web/input"
import "@ui-sdk/web/button"
import "@ui-sdk/web/toast"
import { toast } from "@ui-sdk/web"

const $ = (id) => document.getElementById(id)
const REMOVE_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg>'

let domains = []
let command = "lcd"
let autoSetup = false
let httpsOn = false
const rows = new Map()

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw Object.assign(new Error(data.error || `Request failed (${response.status})`), { field: data.field })
  }
  return data
}

const save = (domain, port, { create = false, scheme } = {}) => api("POST", "/api/domains", { domain, port, create, scheme })

function noteFor(d) {
  if (d.warning) return ["todo", d.warning]
  if (d.dns === "pending") return ["todo", autoSetup ? "Setting up, ready in a few seconds" : "Needs the one-time setup above"]
  if (!d.answering) return ["down", `Nothing is running on port ${d.port}`]
  return ["ok", "Working"]
}

function createRow(d) {
  const li = document.createElement("li")
  li.innerHTML = `
    <div class="name"><a target="_blank" rel="noopener"></a><p class="note"></p></div>
    <select class="row-scheme"><option value="https">https</option><option value="http">http</option></select>
    <label class="target"><span>127.0.0.1:</span><ui-input><input inputmode="numeric" autocomplete="off"></ui-input></label>
    <ui-button><button>${REMOVE_ICON}</button></ui-button>`
  const link = li.querySelector("a")
  link.href = d.url
  link.textContent = d.domain
  const port = li.querySelector("input")
  const scheme = li.querySelector(".row-scheme")
  scheme.setAttribute("aria-label", `http or https for ${d.domain}`)
  scheme.addEventListener("change", async () => {
    try {
      const saved = await save(d.domain, Number(li.dataset.port), { scheme: scheme.value })
      toast(`${saved.domain} now opens over ${saved.scheme}`)
    } catch (error) {
      toast.error(error.message)
    }
    await load()
  })
  port.setAttribute("aria-label", `Port for ${d.domain}`)
  li.querySelector("button").setAttribute("aria-label", `Remove ${d.domain}`)

  port.addEventListener("keydown", (event) => {
    if (event.key === "Enter") port.blur()
    if (event.key === "Escape") {
      port.value = li.dataset.port
      port.blur()
    }
  })
  port.addEventListener("change", async () => {
    if (port.value === li.dataset.port) return
    try {
      const saved = await save(d.domain, Number(port.value))
      toast(`${saved.domain} now opens port ${saved.port}`)
    } catch (error) {
      port.value = li.dataset.port
      toast.error(error.message)
    }
    await load()
  })

  li.querySelector("ui-button").addEventListener("action", async () => {
    const removedPort = Number(li.dataset.port)
    try {
      await api("DELETE", `/api/domains/${encodeURIComponent(d.domain)}`)
      toast(`Removed ${d.domain}`, {
        action: {
          label: "Undo",
          onAction: async () => {
            await save(d.domain, removedPort, { scheme: li.dataset.scheme })
            await load()
          },
        },
      })
    } catch (error) {
      toast.error(error.message)
    }
    await load()
  })
  return li
}

function render() {
  const list = $("list")
  for (const [domain, li] of rows) {
    if (!domains.some((d) => d.domain === domain)) {
      li.remove()
      rows.delete(domain)
    }
  }
  domains.forEach((d, index) => {
    let li = rows.get(d.domain)
    if (!li) rows.set(d.domain, (li = createRow(d)))
    if (list.children[index] !== li) list.insertBefore(li, list.children[index] ?? null)

    const [state, text] = noteFor(d)
    const note = li.querySelector(".note")
    note.dataset.state = state
    note.textContent = text
    li.dataset.port = d.port
    li.dataset.scheme = d.scheme
    li.querySelector("a").href = d.url
    const rowScheme = li.querySelector(".row-scheme")
    rowScheme.hidden = !httpsOn
    if (document.activeElement !== rowScheme) rowScheme.value = d.scheme
    const port = li.querySelector("input")
    if (document.activeElement !== port) port.value = d.port
  })

  $("empty").hidden = domains.length > 0
  $("https-tip").hidden = httpsOn || domains.length === 0
  $("scheme").hidden = !httpsOn
  $("scheme-text").hidden = httpsOn
  $("https-command").textContent = `${command} https`
  const pending = domains.filter((d) => d.dns === "pending").map((d) => d.domain)
  $("setup").hidden = pending.length === 0 || autoSetup
  if (pending.length && !autoSetup) {
    const names = pending.length === 1 ? `${pending[0]} needs` : `${pending.length} domain names need`
    $("setup-text").textContent = `${names} a one-time setup so this computer knows the name. Run this once in a terminal. After that, every name you add sets itself up:`
    $("setup-command").textContent = `sudo ${command} hosts --auto`
  }
}

async function load() {
  try {
    const data = await api("GET", "/api/domains")
    domains = data.domains
    command = data.command
    autoSetup = Boolean(data.autoSetup)
    httpsOn = Boolean(data.https)
    $("offline").hidden = true
  } catch {
    $("offline").hidden = false
    $("empty").hidden = true
    return
  }
  render()
}

function setError(field, message) {
  const el = $(`${field}-field`)
  el.querySelector("ui-field-error")?.remove()
  el.invalid = message ? true : undefined
  if (!message) return
  const error = document.createElement("ui-field-error")
  error.setAttribute("match", "true")
  error.textContent = message
  el.append(error)
}

$("add").addEventListener("input", (event) => setError(event.target.id, ""))

$("add").addEventListener("submit", async (event) => {
  event.preventDefault()
  const domain = $("domain").value.trim()
  const port = $("port").value.trim()
  setError("domain", domain ? "" : "Enter a domain name, for example shop.test")
  setError("port", port ? "" : "Enter a port")
  if (!domain || !port) return (domain ? $("port") : $("domain")).focus()
  try {
    const saved = await save(domain, Number(port), { create: true, scheme: httpsOn ? $("scheme").value : undefined })
    $("add").reset()
    $("domain").focus()
    await load()
  } catch (error) {
    const field = error.field === "port" ? "port" : "domain"
    setError(field, error.message)
    $(field).focus()
  }
})

function copyOnPress(buttonId, sourceId) {
  $(buttonId).addEventListener("action", async () => {
    try {
      await navigator.clipboard.writeText($(sourceId).textContent)
      toast("Copied. Paste it into a terminal.")
    } catch {
      toast.error("Could not copy. Select the command and copy it by hand.")
    }
  })
}
copyOnPress("copy", "setup-command")
copyOnPress("copy-https", "https-command")

const MOON =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1Z"/></svg>'
const SUN =
  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="2.9"/><path d="M8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/></svg>'
const currentTheme = () => (document.documentElement.style.colorScheme === "dark" ? "dark" : "light")
function showThemeButton() {
  const dark = currentTheme() === "dark"
  $("theme").innerHTML = dark ? SUN : MOON
  $("theme").setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode")
  $("theme").title = dark ? "Light mode" : "Dark mode"
}
$("theme").addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark"
  document.documentElement.style.colorScheme = next
  try {
    localStorage.setItem("theme", next)
  } catch {}
  showThemeButton()
})
showThemeButton()

load()
setInterval(() => {
  if (!document.hidden) load()
}, 5000)
