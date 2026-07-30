// save/saveSystem.js — абстракция сохранений (ISaveSystem).
// Браузер: localStorage + файл. Позже: DesktopSave (UE5), CloudSave, SteamSave — тот же интерфейс.
//
// interface ISaveSystem {
//   save(slot: string, json: string): void
//   load(slot: string): string | null
//   list(): string[]
//   remove(slot: string): void
// }

export class BrowserSave {
  constructor(prefix = 'frontier_save_') { this.prefix = prefix; }
  save(slot, json) { try { localStorage.setItem(this.prefix + slot, json); return true; } catch { return false; } }
  load(slot) { try { return localStorage.getItem(this.prefix + slot); } catch { return null; } }
  list() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(this.prefix)) out.push(k.slice(this.prefix.length));
      }
    } catch { }
    return out;
  }
  remove(slot) { try { localStorage.removeItem(this.prefix + slot); } catch { } }
}

// Экспорт/импорт файла (скачивание / выбор)
export class FileSave {
  static export(json, filename = 'frontier-save.json') {
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  static import(onLoad) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const f = input.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => onLoad(r.result);
      r.readAsText(f);
    };
    input.click();
  }
}
