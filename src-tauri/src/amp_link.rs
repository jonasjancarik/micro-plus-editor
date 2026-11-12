//! Writes to the amp from native code, so WebKit slowing a hidden window can't delay the keep-alive.
//!
//! Commands from the page and keep-alives share one lock, so a keep-alive never lands between the
//! packets of a longer command. The amp loses those packets and stops answering if that happens.

use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::async_runtime::{spawn, JoinHandle};
use tauri::ipc::Channel;
use tauri::State;
use tauri_plugin_blec::models::WriteType;
use tokio::sync::Mutex;
use tokio::time::{interval, sleep, MissedTickBehavior};
use uuid::Uuid;

const SERVICE: Uuid = uuid::uuid!("90559580-b707-11ee-acb1-7b7e30f1af54");
const REQUEST: Uuid = uuid::uuid!("820a7e34-4e0a-4f90-8520-04ebce35a3a1");

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepAliveStats {
  sent: u64,
  longest_gap_ms: u64,
  gaps_over_500_ms: u64,
  gaps_over_1000_ms: u64,
  slowest_write_ms: u64,
}

#[derive(Default)]
struct Shared {
  writing: Mutex<()>,
  stats: StdMutex<KeepAliveStats>,
}

#[derive(Default)]
pub struct AmpLink {
  shared: Arc<Shared>,
  keep_alive: StdMutex<Option<JoinHandle<()>>>,
}

fn write_type(without_response: bool) -> WriteType {
  if without_response { WriteType::WithoutResponse } else { WriteType::WithResponse }
}

async fn send(address: &str, data: &[u8], without_response: bool) -> Result<(), String> {
  let handler = tauri_plugin_blec::get_handler().map_err(|error| error.to_string())?;
  handler
    .send_data_to(address, REQUEST, Some(SERVICE), data, write_type(without_response))
    .await
    .map_err(|error| error.to_string())
}

/// Sends the packets of one command in order, with a pause between them.
#[tauri::command]
pub async fn amp_write(
  link: State<'_, AmpLink>,
  address: String,
  packets: Vec<Vec<u8>>,
  gap_ms: u64,
  without_response: bool,
) -> Result<(), String> {
  let _turn = link.shared.writing.lock().await;
  for (index, packet) in packets.iter().enumerate() {
    if index > 0 {
      sleep(Duration::from_millis(gap_ms)).await;
    }
    send(&address, packet, without_response).await?;
  }
  Ok(())
}

/// Sends the packet every so many milliseconds until stopped. Reports the first failed write and stops.
#[tauri::command]
pub fn keep_alive_start(
  link: State<'_, AmpLink>,
  address: String,
  packet: Vec<u8>,
  every_ms: u64,
  without_response: bool,
  on_failure: Channel<String>,
) {
  stop(&link);
  let shared = link.shared.clone();
  *shared.stats.lock().unwrap() = KeepAliveStats::default();
  let task = spawn(async move {
    let mut ticks = interval(Duration::from_millis(every_ms));
    ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut last = Instant::now();
    loop {
      ticks.tick().await;
      let _turn = shared.writing.lock().await;
      let now = Instant::now();
      let gap = now.duration_since(last).as_millis() as u64;
      last = now;
      let result = send(&address, &packet, without_response).await;
      let took = now.elapsed().as_millis() as u64;
      {
        let mut stats = shared.stats.lock().unwrap();
        stats.sent += 1;
        stats.longest_gap_ms = stats.longest_gap_ms.max(gap);
        stats.slowest_write_ms = stats.slowest_write_ms.max(took);
        if gap > 500 { stats.gaps_over_500_ms += 1; }
        if gap > 1000 { stats.gaps_over_1000_ms += 1; }
      }
      if let Err(error) = result {
        let _ = on_failure.send(error);
        return;
      }
    }
  });
  *link.keep_alive.lock().unwrap() = Some(task);
}

fn stop(link: &AmpLink) {
  if let Some(task) = link.keep_alive.lock().unwrap().take() {
    task.abort();
  }
}

#[tauri::command]
pub fn keep_alive_stop(link: State<'_, AmpLink>) {
  stop(&link);
}

/// Returns the numbers since the last call, then starts the longest gap and slowest write again.
#[tauri::command]
pub fn keep_alive_stats(link: State<'_, AmpLink>) -> KeepAliveStats {
  let mut stats = link.shared.stats.lock().unwrap();
  let reported = stats.clone();
  stats.longest_gap_ms = 0;
  stats.slowest_write_ms = 0;
  reported
}
