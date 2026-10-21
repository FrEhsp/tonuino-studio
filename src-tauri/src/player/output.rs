//! The sound card, through cpal: the system's default output (ALSA on
//! Linux, which PipeWire or PulseAudio serve on a desktop; WASAPI on
//! Windows). The stream lives in a thread of its own, since cpal streams
//! may not move between threads on every system.

use super::engine::{Health, Output, OutputFactory, OutputInfo};
use super::mixer::Mixer;
use crate::error::CmdError;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, FromSample, SampleFormat, SizedSample, StreamConfig, StreamError, SupportedBufferSize};
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Frames per callback asked for: about 10 ms, so a new track is heard
/// soon after it is queued. Devices that cannot do that keep their own.
const BUFFER_FRAMES: u32 = 480;

pub struct CpalOutputs;

enum Ctl {
    Run(bool),
}

struct CpalOutput {
    info: OutputInfo,
    /// Dropping it ends the stream's thread, which closes the stream.
    ctl: Sender<Ctl>,
}

impl Output for CpalOutput {
    fn info(&self) -> &OutputInfo {
        &self.info
    }

    fn set_running(&mut self, on: bool) {
        let _ = self.ctl.send(Ctl::Run(on));
    }
}

fn device_name(device: &cpal::Device) -> Option<String> {
    device.id().ok().map(|id| id.to_string())
}

impl OutputFactory for CpalOutputs {
    fn open(&self, mixer: Arc<Mutex<Mixer>>, health: Arc<Health>) -> Result<Box<dyn Output>, CmdError> {
        let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<OutputInfo, CmdError>>(1);
        let (ctl_tx, ctl_rx) = mpsc::channel::<Ctl>();
        std::thread::Builder::new()
            .name("player-output".into())
            .spawn(move || {
                let stream = match open_stream(mixer, health) {
                    Ok((stream, info)) => {
                        let _ = ready_tx.send(Ok(info));
                        stream
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                // Holds the stream until the output is dropped.
                while let Ok(Ctl::Run(on)) = ctl_rx.recv() {
                    let result = if on { stream.play().map_err(|e| e.to_string()) } else { stream.pause().map_err(|e| e.to_string()) };
                    if let Err(e) = result {
                        log::warn!("player output: {e}");
                    }
                }
            })
            .map_err(|e| CmdError::new("output-failed", format!("output thread: {e}")))?;
        let info = ready_rx.recv_timeout(Duration::from_secs(5)).map_err(|_| CmdError::new("output-failed", "the sound output did not answer"))??;
        Ok(Box::new(CpalOutput { info, ctl: ctl_tx }))
    }

    fn default_device(&self) -> Option<String> {
        cpal::default_host().default_output_device().and_then(|d| device_name(&d))
    }
}

fn open_stream(mixer: Arc<Mutex<Mixer>>, health: Arc<Health>) -> Result<(cpal::Stream, OutputInfo), CmdError> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or_else(|| CmdError::new("no-device", "no default output device"))?;
    let supported = device.default_output_config().map_err(|e| CmdError::new("no-device", e.to_string()))?;
    let format = supported.sample_format();
    let mut config: StreamConfig = supported.config();
    let small = match supported.buffer_size() {
        SupportedBufferSize::Range { min, max } => (*min..=*max).contains(&BUFFER_FRAMES),
        SupportedBufferSize::Unknown => false,
    };
    let info = OutputInfo { rate: config.sample_rate, channels: usize::from(config.channels), device: device_name(&device) };
    let attempt = |config: &StreamConfig| build(&device, config, format, mixer.clone(), health.clone());
    let stream = if small {
        config.buffer_size = BufferSize::Fixed(BUFFER_FRAMES);
        attempt(&config).or_else(|_| {
            config.buffer_size = BufferSize::Default;
            attempt(&config)
        })
    } else {
        attempt(&config)
    }?;
    stream.play().map_err(|e| CmdError::new("output-failed", e.to_string()))?;
    Ok((stream, info))
}

fn build(device: &cpal::Device, config: &StreamConfig, format: SampleFormat, mixer: Arc<Mutex<Mixer>>, health: Arc<Health>) -> Result<cpal::Stream, CmdError> {
    match format {
        SampleFormat::F32 => build_typed::<f32>(device, config, mixer, health),
        SampleFormat::I16 => build_typed::<i16>(device, config, mixer, health),
        SampleFormat::I32 => build_typed::<i32>(device, config, mixer, health),
        SampleFormat::U16 => build_typed::<u16>(device, config, mixer, health),
        SampleFormat::F64 => build_typed::<f64>(device, config, mixer, health),
        other => Err(CmdError::new("output-failed", format!("sample format {other} not supported"))),
    }
}

fn build_typed<T>(device: &cpal::Device, config: &StreamConfig, mixer: Arc<Mutex<Mixer>>, health: Arc<Health>) -> Result<cpal::Stream, CmdError>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = usize::from(config.channels.max(1));
    let rate = f64::from(config.sample_rate.max(1));
    let mut scratch: Vec<f32> = Vec::new();
    let beat = health.clone();
    let data = move |out: &mut [T], info: &cpal::OutputCallbackInfo| {
        beat.beat();
        if scratch.len() < out.len() {
            scratch.resize(out.len(), 0.0);
        }
        let buf = &mut scratch[..out.len()];
        {
            let mut m = mixer.lock().unwrap_or_else(|p| p.into_inner());
            // From now until the last frame of this buffer reaches the speaker.
            let ts = info.timestamp();
            let ahead = ts.playback.duration_since(&ts.callback).unwrap_or_default().as_secs_f64();
            m.latency_sec = ahead + (out.len() / channels) as f64 / rate;
            if m.channels == channels && f64::from(m.rate) == rate {
                m.fill(buf);
            } else {
                // The mixer is set to another output (a change is on its way): silence until then.
                buf.iter_mut().for_each(|s| *s = 0.0);
            }
        }
        for (o, s) in out.iter_mut().zip(buf.iter()) {
            *o = T::from_sample(s.clamp(-1.0, 1.0));
        }
    };
    let error = move |e: StreamError| match e {
        StreamError::DeviceNotAvailable | StreamError::StreamInvalidated => {
            log::warn!("player output lost: {e}");
            health.lost.store(true, Ordering::Relaxed);
        }
        // A short gap or a passing complaint of the driver: the stream goes on.
        other => log::debug!("player output: {other}"),
    };
    device.build_output_stream(config, data, error, None).map_err(|e| CmdError::new("output-failed", e.to_string()))
}
