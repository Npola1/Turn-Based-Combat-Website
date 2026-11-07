/** Resolve the user's selected browser. This module never launches a browser. */
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path';

const execFile = promisify(execFileCallback);
const run = async (command, args) => (await execFile(command, args, { timeout: 10000, maxBuffer: 1024 * 1024 })).stdout.trim();
const chromium = /chrome|chromium|brave|microsoft.?edge|msedge|vivaldi|opera|(^|[./ ])arc([./ ]|$)/i;
const macDefaultScript = `use framework "AppKit"
set targetURL to current application's NSURL's URLWithString:"https://example.com"
set appURL to current application's NSWorkspace's sharedWorkspace()'s URLForApplicationToOpenURL:targetURL
if appURL is missing value then error "No default browser is registered"
return appURL's |path|() as text`;

async function onPath(command, env) {
  if (isAbsolute(command)) return command;
  for (const directory of (env.PATH || '').split(delimiter)) {
    const file = resolve(directory, command);
    try { await access(file, constants.X_OK); return file; } catch {}
  }
  throw Error(`Default browser executable was not found on PATH: ${command}`);
}

async function systemDefault(platform, env) {
  if (platform === 'darwin') {
    try { return await run('/usr/bin/osascript', ['-e', macDefaultScript]); }
    catch (error) {
      // A sandbox can block AppKit while allowing LaunchServices preferences to be read.
      const preferences = join(homedir(), 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist');
      let handlers;
      try { handlers = JSON.parse(await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', preferences])).LSHandlers; }
      catch { throw Error(`Cannot read the system default browser: ${error.message}`); }
      const handler = handlers?.find(h => h.LSHandlerContentType === 'com.apple.default-app.web-browser') || handlers?.find(h => h.LSHandlerURLScheme === 'https') || handlers?.find(h => h.LSHandlerURLScheme === 'http');
      const id = handler?.LSHandlerRoleAll;
      if (!id || !/^[A-Za-z0-9.-]+$/.test(id)) throw Error('Cannot identify the system default browser. No alternative browser was selected.');
      try { return await run('/usr/bin/osascript', ['-e', `POSIX path of (path to application id "${id}")`]); }
      catch {
        for(const directory of ['/Applications',join(homedir(),'Applications'),'/System/Applications']) {
          let applications;try{applications=await readdir(directory);}catch{continue;}
          const matches=await Promise.all(applications.filter(name=>name.endsWith('.app')).map(async name=>{
            const application=join(directory,name);
            try{const info=JSON.parse(await run('/usr/bin/plutil',['-convert','json','-o','-',join(application,'Contents/Info.plist')]));return info.CFBundleIdentifier===id?application:null;}catch{return null;}
          }));
          const match=matches.find(Boolean);if(match)return match;
        }
        throw Error(`Your default browser (${id}) could not be located. No alternative browser was selected.`);
      }
    }
  }
  if (platform === 'linux') {
    const desktop = await run('xdg-settings', ['get', 'default-web-browser']);
    if (!desktop || desktop.includes('/') || !desktop.endsWith('.desktop')) throw Error('Cannot identify the system default browser desktop entry.');
    const roots = [env.XDG_DATA_HOME || join(homedir(), '.local/share'), ...(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')];
    for (const directory of roots) {
      let source;
      try { source = await readFile(join(directory, 'applications', desktop), 'utf8'); } catch { continue; }
      const entry = /^Exec=(?:"([^"]+)"|(\S+))/m.exec(source);
      if (!entry) throw Error(`The default browser desktop entry has no executable: ${desktop}`);
      const command = entry[1] || entry[2];
      if (['env', 'flatpak', 'snap'].includes(basename(command))) throw Error(`The default browser uses a launcher (${command}). Set RPG_TEST_BROWSER explicitly to its browser executable.`);
      return onPath(command, env);
    }
    throw Error(`Default browser desktop entry was not found: ${desktop}`);
  }
  if (platform === 'win32') {
    const setting = await run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId']);
    const id = /ProgId\s+REG_SZ\s+(.+)/i.exec(setting)?.[1]?.trim();
    if (!id) throw Error('Cannot identify the Windows default browser.');
    const registration = await run('reg.exe', ['query', `HKCR\\${id}\\shell\\open\\command`, '/ve']);
    const command = /REG_(?:EXPAND_)?SZ\s+(.+)/i.exec(registration)?.[1]?.trim();
    const executable = command && /^(?:"([^"]+\.exe)"|(.+?\.exe))(?:\s|$)/i.exec(command);
    if (!executable) throw Error(`Cannot resolve the default browser executable for ${id}.`);
    return (executable[1] || executable[2]).replace(/%([^%]+)%/g, (_, name) => env[name] || `%${name}%`);
  }
  throw Error(`Default browser detection is unavailable on ${platform}. Set RPG_TEST_BROWSER explicitly; no alternative browser was selected.`);
}

async function inspectBrowser(selected, platform, env) {
  let executable = selected, name = basename(selected), bundleId = '';
  if (platform === 'darwin' && /\.app\/?$/.test(selected)) {
    const application = selected.replace(/\/$/, '');
    const info = JSON.parse(await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(application, 'Contents/Info.plist')]));
    if (!info.CFBundleExecutable || /[\\/]/.test(info.CFBundleExecutable)) throw Error('Default browser bundle has an invalid executable.');
    executable = join(application, 'Contents/MacOS', info.CFBundleExecutable);
    name = info.CFBundleDisplayName || info.CFBundleName || basename(application, '.app');
    bundleId = info.CFBundleIdentifier || '';
  } else executable = await onPath(selected, env);
  await access(executable, constants.X_OK);
  return { executable, name, bundleId };
}

/** Dependencies can be supplied by unit tests; selection never falls back to another app. */
export async function resolveTestBrowser({ platform = process.platform, env = process.env, getDefault = systemDefault, inspect = inspectBrowser } = {}) {
  const override = env.RPG_TEST_BROWSER?.trim();
  let selected;
  try { selected = override || await getDefault(platform, env); }
  catch (error) { throw Error(`Could not resolve your default browser. ${error.message}`); }
  if (!selected) throw Error('No default browser was returned. No alternative browser was selected.');
  let browser;
  try { browser = await inspect(selected, platform, env); }
  catch (error) { throw Error(`Cannot use ${override ? 'RPG_TEST_BROWSER' : 'your default browser'} (${selected}): ${error.message}. No alternative browser was selected.`); }
  const engine = /firefox|org\.mozilla/i.test(`${browser.name} ${browser.bundleId} ${basename(browser.executable)}`) ? 'firefox' : chromium.test(`${browser.name} ${browser.bundleId} ${basename(browser.executable)}`) ? 'chromium' : null;
  if (!engine) {
    throw Error(`Your selected browser is ${browser.name}. These test runners support Chromium and Firefox automation and cannot automate this browser. No browser was opened or substituted. A different browser requires an explicit RPG_TEST_BROWSER override.`);
  }
  return { ...browser, engine, source: override ? 'explicit RPG_TEST_BROWSER override' : 'system default browser' };
}
