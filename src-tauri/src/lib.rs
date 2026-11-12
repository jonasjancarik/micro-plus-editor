mod amp_link;

use std::time::{SystemTime, UNIX_EPOCH};

/// Prints a line from the page to the terminal, so a test run can be followed without the web inspector.
#[tauri::command]
fn log_line(line: String) {
  let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
  println!("[page {}.{:03}] {}", ms / 1000 % 100_000, ms % 1000, line);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_blec::init())
    .manage(amp_link::AmpLink::default())
    .invoke_handler(tauri::generate_handler![
      log_line,
      amp_link::amp_write,
      amp_link::keep_alive_start,
      amp_link::keep_alive_stop,
      amp_link::keep_alive_stats,
    ])
    .run(tauri::generate_context!())
    .expect("error while running Micro Plus");
}
