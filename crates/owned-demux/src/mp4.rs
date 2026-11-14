// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

use crate::{codec_metadata, Error, Packet, Track, MAX_SAMPLES, METADATA_BUDGET, PACKET_BUDGET};
use std::collections::BTreeMap;

#[derive(Clone, Copy)]
struct Atom<'a> {
    kind: [u8; 4],
    data: &'a [u8],
}

fn u16be(data: &[u8], at: usize) -> Result<u16, Error> {
    let bytes = data.get(at..at + 2).ok_or(Error::Truncated)?;
    Ok(u16::from_be_bytes(bytes.try_into().unwrap()))
}
fn u32be(data: &[u8], at: usize) -> Result<u32, Error> {
    let bytes = data.get(at..at + 4).ok_or(Error::Truncated)?;
    Ok(u32::from_be_bytes(bytes.try_into().unwrap()))
}
fn i32be(data: &[u8], at: usize) -> Result<i32, Error> {
    Ok(u32be(data, at)? as i32)
}
fn u64be(data: &[u8], at: usize) -> Result<u64, Error> {
    let bytes = data.get(at..at + 8).ok_or(Error::Truncated)?;
    Ok(u64::from_be_bytes(bytes.try_into().unwrap()))
}

fn atoms(data: &[u8]) -> Result<Vec<Atom<'_>>, Error> {
    let mut result = Vec::new();
    let mut at = 0usize;
    while at < data.len() {
        if result.len() > 4096 {
            return Err(Error::ResourceLimit);
        }
        let size32 = u32be(data, at)? as usize;
        let kind: [u8; 4] = data
            .get(at + 4..at + 8)
            .ok_or(Error::Truncated)?
            .try_into()
            .unwrap();
        let (size, header) = if size32 == 1 {
            (
                usize::try_from(u64be(data, at + 8)?).map_err(|_| Error::ResourceLimit)?,
                16usize,
            )
        } else if size32 == 0 {
            (data.len() - at, 8)
        } else {
            (size32, 8)
        };
        if size < header {
            return Err(Error::Invalid);
        }
        let end = at.checked_add(size).ok_or(Error::Overflow)?;
        if end > data.len() {
            return Err(Error::Truncated);
        }
        result.push(Atom {
            kind,
            data: &data[at + header..end],
        });
        at = end;
    }
    Ok(result)
}

fn atom_at(data: &[u8], at: usize, limit: usize) -> Result<([u8; 4], usize, usize), Error> {
    if at >= limit || limit > data.len() {
        return Err(Error::Invalid);
    }
    let size32 = u32be(data, at)? as usize;
    let kind: [u8; 4] = data
        .get(at + 4..at + 8)
        .ok_or(Error::Truncated)?
        .try_into()
        .unwrap();
    let (size, header) = if size32 == 1 {
        (
            usize::try_from(u64be(data, at + 8)?).map_err(|_| Error::ResourceLimit)?,
            16,
        )
    } else if size32 == 0 {
        (limit - at, 8)
    } else {
        (size32, 8)
    };
    if size < header {
        return Err(Error::Invalid);
    }
    let end = at.checked_add(size).ok_or(Error::Overflow)?;
    if end > limit {
        return Err(Error::Truncated);
    }
    Ok((kind, at + header, end))
}

fn child(data: &[u8], kind: [u8; 4]) -> Result<Option<&[u8]>, Error> {
    Ok(atoms(data)?
        .into_iter()
        .find(|atom| atom.kind == kind)
        .map(|atom| atom.data))
}
fn required(data: &[u8], kind: [u8; 4]) -> Result<&[u8], Error> {
    child(data, kind)?.ok_or(Error::Unsupported)
}

struct SampleDescription {
    codec: [u8; 4],
    width: u32,
    height: u32,
    display_width: u32,
    display_height: u32,
    color_primaries: u16,
    color_transfer: u16,
    color_matrix: u16,
    color_full_range: i8,
    description: Vec<u8>,
}
fn sample_description(data: &[u8]) -> Result<SampleDescription, Error> {
    if u32be(data, 4)? == 0 {
        return Err(Error::Unsupported);
    }
    let entry = data.get(8..).ok_or(Error::Truncated)?;
    let size = u32be(entry, 0)? as usize;
    if size < 86 || size > entry.len() {
        return Err(Error::Invalid);
    }
    let codec: [u8; 4] = entry[4..8].try_into().unwrap();
    let width = u16be(entry, 32)? as u32;
    let height = u16be(entry, 34)? as u32;
    if width == 0 || height == 0 {
        return Err(Error::Invalid);
    }
    let extra = &entry[86..size];
    let config_kind = match &codec {
        b"avc1" | b"avc3" => *b"avcC",
        b"hvc1" | b"hev1" => *b"hvcC",
        b"vp09" => *b"vpcC",
        b"av01" => *b"av1C",
        _ => return Err(Error::Unsupported),
    };
    let description = required(extra, config_kind)?;
    if description.is_empty() || description.len() > 1024 * 1024 {
        return Err(Error::ResourceLimit);
    }
    let signal = codec_metadata::from_config(codec, description)?;
    let (display_width, display_height) = if let Some(pasp) = child(extra, *b"pasp")? {
        let h = u32be(pasp, 0)?;
        let v = u32be(pasp, 4)?;
        if h == 0 || v == 0 {
            return Err(Error::Invalid);
        }
        (
            width.checked_mul(h).ok_or(Error::Overflow)?,
            height.checked_mul(v).ok_or(Error::Overflow)?,
        )
    } else {
        let (num, den) = signal.map_or((1, 1), |metadata| (metadata.sar_num, metadata.sar_den));
        (
            width.checked_mul(num).ok_or(Error::Overflow)?,
            height.checked_mul(den).ok_or(Error::Overflow)?,
        )
    };
    let (color_primaries, color_transfer, color_matrix, color_full_range) =
        if let Some(colr) = child(extra, *b"colr")? {
            if colr.get(..4) == Some(b"nclx") {
                (
                    u16be(colr, 4)?,
                    u16be(colr, 6)?,
                    u16be(colr, 8)?,
                    if colr.get(10).ok_or(Error::Truncated)? & 0x80 != 0 {
                        1
                    } else {
                        0
                    },
                )
            } else {
                signal.map_or((u16::MAX, u16::MAX, u16::MAX, -1), |metadata| {
                    (
                        metadata.color_primaries,
                        metadata.color_transfer,
                        metadata.color_matrix,
                        metadata.color_full_range,
                    )
                })
            }
        } else {
            signal.map_or((u16::MAX, u16::MAX, u16::MAX, -1), |metadata| {
                (
                    metadata.color_primaries,
                    metadata.color_transfer,
                    metadata.color_matrix,
                    metadata.color_full_range,
                )
            })
        };
    Ok(SampleDescription {
        codec,
        width,
        height,
        display_width,
        display_height,
        color_primaries,
        color_transfer,
        color_matrix,
        color_full_range,
        description: description.to_vec(),
    })
}

fn tkhd_rotation(data: &[u8]) -> Result<u16, Error> {
    let matrix = if data.first().copied().ok_or(Error::Truncated)? == 1 {
        52
    } else {
        40
    };
    let a = i32be(data, matrix)?;
    let b = i32be(data, matrix + 4)?;
    let c = i32be(data, matrix + 12)?;
    let d = i32be(data, matrix + 16)?;
    const ONE: i32 = 1 << 16;
    Ok(if a == 0 && b == ONE && c == -ONE && d == 0 {
        90
    } else if a == -ONE && b == 0 && c == 0 && d == -ONE {
        180
    } else if a == 0 && b == -ONE && c == ONE && d == 0 {
        270
    } else {
        0
    })
}

fn mdhd(data: &[u8]) -> Result<(u32, u64), Error> {
    if data.first().copied().ok_or(Error::Truncated)? == 1 {
        let scale = u32be(data, 20)?;
        if scale == 0 {
            return Err(Error::Invalid);
        }
        Ok((scale, u64be(data, 24)?))
    } else {
        let scale = u32be(data, 12)?;
        if scale == 0 {
            return Err(Error::Invalid);
        }
        Ok((scale, u32be(data, 16)? as u64))
    }
}

pub fn parse_moov(data: &[u8]) -> Result<(Track, Option<(usize, usize)>), Error> {
    let mvhd = required(data, *b"mvhd")?;
    let movie_scale = u32be(mvhd, if mvhd.first() == Some(&1) { 20 } else { 12 })?;
    if movie_scale == 0 {
        return Err(Error::Invalid);
    }
    let trex = child(data, *b"mvex")?;
    let children = atoms(data)?;
    for atom in children {
        if atom.kind != *b"trak" {
            continue;
        }
        let mdia = required(atom.data, *b"mdia")?;
        let hdlr = required(mdia, *b"hdlr")?;
        if hdlr.get(8..12) != Some(b"vide") {
            continue;
        }
        let tkhd = required(atom.data, *b"tkhd")?;
        let track_id = u32be(tkhd, if tkhd.first() == Some(&1) { 20 } else { 12 })?;
        if track_id == 0 {
            return Err(Error::Invalid);
        }
        let (timescale, duration) = mdhd(required(mdia, *b"mdhd")?)?;
        let edit_shift = if let Some(edts) = child(atom.data, *b"edts")? {
            child(edts, *b"elst")?
                .map(|elst| edit_offset(elst, movie_scale, timescale))
                .transpose()?
                .unwrap_or(0)
        } else {
            0
        };
        let rotation = tkhd_rotation(tkhd)?;
        let minf = required(mdia, *b"minf")?;
        let stbl = required(minf, *b"stbl")?;
        let sample = sample_description(required(stbl, *b"stsd")?)?;
        let defaults = trex
            .and_then(|mvex| child(mvex, *b"trex").ok().flatten())
            .filter(|entry| u32be(entry, 4).ok() == Some(track_id));
        let (fragment_default_duration, fragment_default_size, fragment_default_flags) =
            if let Some(entry) = defaults {
                if u32be(entry, 8)? != 1 {
                    return Err(Error::Unsupported);
                }
                (u32be(entry, 12)?, u32be(entry, 16)?, u32be(entry, 20)?)
            } else {
                (0, 0, 0)
            };
        let (packets, table_range) =
            if child(stbl, *b"stsz")?.is_some_and(|table| u32be(table, 8).unwrap_or(0) > 0) {
                let start = (stbl.as_ptr() as usize)
                    .checked_sub(data.as_ptr() as usize)
                    .ok_or(Error::Invalid)?;
                if start.checked_add(stbl.len()).ok_or(Error::Overflow)? > data.len() {
                    return Err(Error::Invalid);
                }
                (Vec::new(), Some((start, stbl.len())))
            } else if defaults.is_some() {
                (Vec::new(), None)
            } else {
                return Err(Error::Unsupported);
            };
        return Ok((
            Track {
                track_id,
                codec: sample.codec,
                width: sample.width,
                height: sample.height,
                display_width: sample.display_width,
                display_height: sample.display_height,
                color_primaries: sample.color_primaries,
                color_transfer: sample.color_transfer,
                color_matrix: sample.color_matrix,
                color_full_range: sample.color_full_range,
                timescale,
                duration,
                rotation,
                description: sample.description,
                packets,
                fragment_default_duration: u64::from(fragment_default_duration),
                fragment_default_size,
                fragment_default_flags,
                edit_shift,
            },
            table_range,
        ));
    }
    Err(Error::Unsupported)
}

fn edit_offset(elst: &[u8], movie_scale: u32, media_scale: u32) -> Result<i64, Error> {
    let version = *elst.first().ok_or(Error::Truncated)?;
    let count = u32be(elst, 4)? as usize;
    if count > 32 {
        return Err(Error::ResourceLimit);
    }
    let mut at = 8usize;
    let mut empty_movie = 0u64;
    for _ in 0..count {
        let (segment, media, step) = if version == 1 {
            (u64be(elst, at)?, u64be(elst, at + 8)? as i64, 20)
        } else {
            (u32be(elst, at)? as u64, i32be(elst, at + 4)? as i64, 12)
        };
        at += step;
        if media == -1 {
            empty_movie = empty_movie.checked_add(segment).ok_or(Error::Overflow)?;
        } else if media >= 0 {
            let leading = (empty_movie as i128) * (media_scale as i128) / (movie_scale as i128);
            return i64::try_from(leading - media as i128).map_err(|_| Error::Overflow);
        } else {
            return Err(Error::Invalid);
        }
    }
    Ok(0)
}

/// Retains one moof and advances at most the caller's atom/sample credit.
pub struct FragmentBuilder {
    raw: Vec<u8>,
    box_start: u64,
    file_len: u64,
    at: usize,
    implicit_base: u64,
    traf: Option<TrafCursor>,
}
struct TrafCursor {
    at: usize,
    end: usize,
    id: u32,
    base: u64,
    default_duration: u64,
    default_size: u32,
    default_flags: u32,
    dts: u64,
    data_end: u64,
    trun: Option<TrunCursor>,
    presentation: BTreeMap<(i64, usize), usize>,
}
struct TrunCursor {
    at: usize,
    end: usize,
    version: u8,
    flags: u32,
    count: usize,
    index: usize,
    offset: u64,
    first_flags: Option<u32>,
}
impl FragmentBuilder {
    pub fn new(raw: Vec<u8>, box_start: u64, file_len: u64) -> Result<Self, Error> {
        if raw.len() > METADATA_BUDGET {
            return Err(Error::ResourceLimit);
        }
        Ok(Self {
            raw,
            box_start,
            file_len,
            at: 0,
            implicit_base: box_start,
            traf: None,
        })
    }

    fn start_traf(&mut self, start: usize, end: usize, track: &Track) -> Result<(), Error> {
        let body = &self.raw[start..end];
        let tfhd = required(body, *b"tfhd")?;
        let flags = u32be(tfhd, 0)? & 0x00ff_ffff;
        let id = u32be(tfhd, 4)?;
        let mut at = 8usize;
        let explicit_base = if flags & 0x000001 != 0 {
            let value = u64be(tfhd, at)?;
            at += 8;
            Some(value)
        } else {
            None
        };
        if flags & 0x000002 != 0 {
            if u32be(tfhd, at)? != 1 {
                return Err(Error::Unsupported);
            }
            at += 4;
        }
        let default_duration = if flags & 0x000008 != 0 {
            let value = u64::from(u32be(tfhd, at)?);
            at += 4;
            value
        } else {
            track.fragment_default_duration
        };
        let default_size = if flags & 0x000010 != 0 {
            let value = u32be(tfhd, at)?;
            at += 4;
            value
        } else {
            track.fragment_default_size
        };
        let default_flags = if flags & 0x000020 != 0 {
            u32be(tfhd, at)?
        } else {
            track.fragment_default_flags
        };
        let base = explicit_base.unwrap_or(if flags & 0x020000 != 0 {
            self.box_start
        } else {
            self.implicit_base
        });
        let tfdt = required(body, *b"tfdt")?;
        let dts = if tfdt.first() == Some(&1) {
            u64be(tfdt, 4)?
        } else {
            u32be(tfdt, 4)? as u64
        };
        self.traf = Some(TrafCursor {
            at: start,
            end,
            id,
            base,
            default_duration,
            default_size,
            default_flags,
            dts,
            data_end: base,
            trun: None,
            presentation: BTreeMap::new(),
        });
        Ok(())
    }

    fn start_trun(&mut self, start: usize, end: usize, track: &mut Track) -> Result<(), Error> {
        let traf = self.traf.as_mut().ok_or(Error::Invalid)?;
        let body = &self.raw[start..end];
        let flags = u32be(body, 0)? & 0x00ff_ffff;
        let count = u32be(body, 4)? as usize;
        if count > MAX_SAMPLES || track.packets.len().saturating_add(count) > MAX_SAMPLES {
            return Err(Error::ResourceLimit);
        }
        let mut at = 8usize;
        let data_offset = if flags & 0x000001 != 0 {
            let value = i32be(body, at)?;
            at += 4;
            Some(value)
        } else {
            None
        };
        let first_flags = if flags & 0x000004 != 0 {
            let value = u32be(body, at)?;
            at += 4;
            Some(value)
        } else {
            None
        };
        let offset = if let Some(delta) = data_offset {
            let absolute = (traf.base as i128) + (delta as i128);
            if absolute < 0 || absolute > self.file_len as i128 {
                return Err(Error::Invalid);
            }
            absolute as u64
        } else {
            traf.data_end
        };
        let words = (flags & 0x000100 != 0) as usize
            + (flags & 0x000200 != 0) as usize
            + (flags & 0x000400 != 0) as usize
            + (flags & 0x000800 != 0) as usize;
        if at
            .checked_add(count.checked_mul(words * 4).ok_or(Error::Overflow)?)
            .is_none_or(|required| required > body.len())
        {
            return Err(Error::Truncated);
        }
        if traf.id == track.track_id {
            let packet_total = track
                .packets
                .len()
                .checked_add(count)
                .ok_or(Error::Overflow)?;
            let indexed = traf
                .presentation
                .len()
                .checked_add(count)
                .ok_or(Error::Overflow)?;
            let old_capacity = track.packets.capacity();
            let admitted_capacity = packet_total.max(old_capacity);
            let overlapping_capacity = if packet_total > old_capacity {
                admitted_capacity
                    .checked_add(old_capacity)
                    .ok_or(Error::Overflow)?
            } else {
                admitted_capacity
            };
            let estimated = self
                .raw
                .len()
                .checked_add(track.description.capacity())
                .and_then(|n| n.checked_add(crate::INPUT_CAPACITY))
                .and_then(|n| {
                    n.checked_add(overlapping_capacity.checked_mul(std::mem::size_of::<Packet>())?)
                })
                .and_then(|n| n.checked_add(indexed.checked_mul(96)?))
                .ok_or(Error::Overflow)?;
            if estimated > METADATA_BUDGET {
                return Err(Error::ResourceLimit);
            }
            track
                .packets
                .try_reserve_exact(count)
                .map_err(|_| Error::ResourceLimit)?;
            if track.packets.capacity() > admitted_capacity {
                return Err(Error::ResourceLimit);
            }
        }
        traf.trun = Some(TrunCursor {
            at: start + at,
            end,
            version: *body.first().ok_or(Error::Truncated)?,
            flags,
            count,
            index: 0,
            offset,
            first_flags,
        });
        Ok(())
    }

    fn one_sample(&mut self, track: &mut Track) -> Result<(), Error> {
        let traf = self.traf.as_mut().ok_or(Error::Invalid)?;
        let trun = traf.trun.as_mut().ok_or(Error::Invalid)?;
        let body = &self.raw[..trun.end];
        let flags = trun.flags;
        let duration = if flags & 0x000100 != 0 {
            let value = u64::from(u32be(body, trun.at)?);
            trun.at += 4;
            value
        } else {
            traf.default_duration
        };
        let size = if flags & 0x000200 != 0 {
            let value = u32be(body, trun.at)?;
            trun.at += 4;
            value
        } else {
            traf.default_size
        };
        let sample_flags = if flags & 0x000400 != 0 {
            let value = u32be(body, trun.at)?;
            trun.at += 4;
            value
        } else if trun.index == 0 {
            trun.first_flags.unwrap_or(traf.default_flags)
        } else {
            traf.default_flags
        };
        let composition = if flags & 0x000800 != 0 {
            let value = u32be(body, trun.at)?;
            trun.at += 4;
            if trun.version == 1 {
                value as i32 as i64
            } else {
                value as i64
            }
        } else {
            0
        };
        let end = trun
            .offset
            .checked_add(size as u64)
            .ok_or(Error::Overflow)?;
        if size == 0 || size > PACKET_BUDGET || end > self.file_len {
            return Err(Error::ResourceLimit);
        }
        let packet_dts = i64::try_from(traf.dts)
            .map_err(|_| Error::Overflow)?
            .checked_add(track.edit_shift)
            .ok_or(Error::Overflow)?;
        let pts = packet_dts.checked_add(composition).ok_or(Error::Overflow)?;
        if traf.id == track.track_id {
            let decode_index = track.packets.len();
            let key = (pts, decode_index);
            let previous = traf
                .presentation
                .range(..key)
                .next_back()
                .map(|(position, index)| (position.0, *index));
            let following = traf
                .presentation
                .range(key..)
                .next()
                .map(|(position, _)| position.0);
            if let Some((previous_pts, previous_index)) = previous {
                track.packets[previous_index].duration =
                    u64::try_from(pts.checked_sub(previous_pts).ok_or(Error::Overflow)?)
                        .map_err(|_| Error::Overflow)?;
            }
            let frame_duration = if let Some(following_pts) = following {
                u64::try_from(following_pts.checked_sub(pts).ok_or(Error::Overflow)?)
                    .map_err(|_| Error::Overflow)?
            } else {
                duration
            };
            track.packets.push(Packet {
                offset: trun.offset,
                size,
                dts: packet_dts,
                pts,
                duration: frame_duration,
                key: sample_flags & 0x00010000 == 0,
            });
            traf.presentation.insert(key, decode_index);
        }
        traf.dts = traf.dts.checked_add(duration).ok_or(Error::Overflow)?;
        trun.offset = end;
        trun.index += 1;
        if trun.index == trun.count {
            traf.data_end = end;
            traf.trun = None;
        }
        Ok(())
    }

    pub fn advance(&mut self, track: &mut Track, credit: u32) -> Result<bool, Error> {
        for _ in 0..credit.clamp(1, 64) {
            if self.traf.as_ref().is_some_and(|traf| traf.trun.is_some()) {
                self.one_sample(track)?;
                continue;
            }
            if let Some(traf) = &mut self.traf {
                if traf.at == traf.end {
                    self.implicit_base = traf.data_end;
                    self.traf = None;
                    continue;
                }
                let (kind, start, end) = atom_at(&self.raw, traf.at, traf.end)?;
                traf.at = end;
                if kind == *b"trun" {
                    self.start_trun(start, end, track)?;
                }
                continue;
            }
            if self.at == self.raw.len() {
                return Ok(true);
            }
            let (kind, start, end) = atom_at(&self.raw, self.at, self.raw.len())?;
            self.at = end;
            if kind == *b"traf" {
                self.start_traf(start, end, track)?;
            }
        }
        Ok(self.at == self.raw.len() && self.traf.is_none())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_zero_size_and_short_boxes() {
        assert_eq!(
            atoms(&[0, 0, 0, 4, b'm', b'o', b'o', b'v']).err(),
            Some(Error::Invalid)
        );
        assert_eq!(
            atoms(&[0, 0, 0, 16, b'm', b'o', b'o', b'v']).err(),
            Some(Error::Truncated)
        );
    }
    #[test]
    fn signed_composition_offsets_preserve_decode_order() {
        assert_eq!(
            edit_offset(
                &[0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 3, 232, 0, 0, 0, 100, 0, 1, 0, 0],
                1000,
                1000
            ),
            Ok(-100)
        );
    }

    #[test]
    fn fragment_samples_yield_before_completing_large_trun() {
        fn atom(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
            let mut bytes = Vec::new();
            bytes.extend_from_slice(&((body.len() + 8) as u32).to_be_bytes());
            bytes.extend_from_slice(kind);
            bytes.extend_from_slice(body);
            bytes
        }
        let tfhd = atom(b"tfhd", &[0, 2, 0, 24, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
        let tfdt = atom(b"tfdt", &[0, 0, 0, 0, 0, 0, 0, 0]);
        let trun = atom(b"trun", &[0, 0, 0, 1, 0, 0, 0, 128, 0, 0, 1, 244]);
        let mut traf = Vec::new();
        traf.extend_from_slice(&tfhd);
        traf.extend_from_slice(&tfdt);
        traf.extend_from_slice(&trun);
        let raw = atom(b"traf", &traf);
        let mut builder = FragmentBuilder::new(raw, 0, 1000).unwrap();
        let mut track = Track {
            track_id: 1,
            codec: *b"avc1",
            width: 16,
            height: 16,
            display_width: 16,
            display_height: 16,
            color_primaries: 0,
            color_transfer: 0,
            color_matrix: 0,
            color_full_range: -1,
            timescale: 1000,
            duration: 0,
            rotation: 0,
            description: Vec::new(),
            packets: Vec::new(),
            fragment_default_duration: 0,
            fragment_default_size: 0,
            fragment_default_flags: 0,
            edit_shift: 0,
        };
        assert!(!builder.advance(&mut track, 64).unwrap());
        assert!(track.packets.len() < 64);
        assert!(!builder.advance(&mut track, 64).unwrap());
        assert!(track.packets.len() < 128);
        while !builder.advance(&mut track, 64).unwrap() {}
        assert_eq!(track.packets.len(), 128);
        assert_eq!(track.packets[0].offset, 500);
        assert_eq!(track.packets[127].offset, 627);
    }
}

#[derive(Clone, Copy)]
struct TableRef {
    start: usize,
    count: usize,
    width: usize,
}
impl TableRef {
    fn entry<'a>(&self, raw: &'a [u8], index: usize) -> Result<&'a [u8], Error> {
        if index >= self.count {
            return Err(Error::Invalid);
        }
        let start = self
            .start
            .checked_add(index.checked_mul(self.width).ok_or(Error::Overflow)?)
            .ok_or(Error::Overflow)?;
        raw.get(start..start + self.width).ok_or(Error::Truncated)
    }
}
fn table_with_count(
    raw: &[u8],
    body: &[u8],
    start: usize,
    width: usize,
    count_at: usize,
) -> Result<TableRef, Error> {
    let count = u32be(body, count_at)? as usize;
    if count > MAX_SAMPLES {
        return Err(Error::ResourceLimit);
    }
    let end = start
        .checked_add(count.checked_mul(width).ok_or(Error::Overflow)?)
        .ok_or(Error::Overflow)?;
    if end > body.len() {
        return Err(Error::Truncated);
    }
    let absolute = (body.as_ptr() as usize)
        .checked_sub(raw.as_ptr() as usize)
        .and_then(|offset| offset.checked_add(start))
        .ok_or(Error::Invalid)?;
    if absolute.checked_add(count * width).ok_or(Error::Overflow)? > raw.len() {
        return Err(Error::Invalid);
    }
    Ok(TableRef {
        start: absolute,
        count,
        width,
    })
}
fn table(raw: &[u8], body: &[u8], start: usize, width: usize) -> Result<TableRef, Error> {
    table_with_count(raw, body, start, width, 4)
}

/// Retains encoded box tables, expanding at most the caller's sample credit per step.
/// Raw table bytes plus admitted packed packet storage share the metadata reserve.
pub struct IndexBuilder {
    raw: Vec<u8>,
    file_len: u64,
    sizes: TableRef,
    fixed_size: u32,
    offsets: TableRef,
    stsc: TableRef,
    stts: TableRef,
    ctts: Option<TableRef>,
    ctts_signed: bool,
    stss: Option<TableRef>,
    sample_at: usize,
    chunk_at: usize,
    chunk_run_at: usize,
    sample_in_chunk: u32,
    per_chunk: u32,
    offset: u64,
    dts: i64,
    stts_at: usize,
    stts_remaining: u32,
    stts_value: u32,
    ctts_at: usize,
    ctts_remaining: u32,
    ctts_value: u32,
    stss_at: usize,
}
impl IndexBuilder {
    pub fn new(
        raw: Vec<u8>,
        stbl_range: (usize, usize),
        file_len: u64,
        track: &mut Track,
    ) -> Result<Self, Error> {
        let stbl = raw
            .get(stbl_range.0..stbl_range.0 + stbl_range.1)
            .ok_or(Error::Invalid)?;
        let sizes_body = required(stbl, *b"stsz")?;
        let fixed_size = u32be(sizes_body, 4)?;
        let sizes = table_with_count(&raw, sizes_body, 12, if fixed_size == 0 { 4 } else { 0 }, 8)?;
        if sizes.count == 0 {
            return Err(Error::Unsupported);
        }
        let (offsets_body, wide) = if let Some(body) = child(stbl, *b"co64")? {
            (body, true)
        } else {
            (required(stbl, *b"stco")?, false)
        };
        let offsets = table(&raw, offsets_body, 8, if wide { 8 } else { 4 })?;
        if offsets.count == 0 {
            return Err(Error::Invalid);
        }
        let stsc = table(&raw, required(stbl, *b"stsc")?, 8, 12)?;
        let stts = table(&raw, required(stbl, *b"stts")?, 8, 8)?;
        if stsc.count == 0 || stts.count == 0 {
            return Err(Error::Invalid);
        }
        let ctts_body = child(stbl, *b"ctts")?;
        let ctts_signed = ctts_body.is_some_and(|body| body.first() == Some(&1));
        let ctts = ctts_body.map(|body| table(&raw, body, 8, 8)).transpose()?;
        let stss = child(stbl, *b"stss")?
            .map(|body| table(&raw, body, 8, 4))
            .transpose()?;
        let packet_bytes = sizes
            .count
            .checked_mul(std::mem::size_of::<Packet>())
            .ok_or(Error::Overflow)?;
        if raw
            .len()
            .checked_add(packet_bytes)
            .and_then(|n| n.checked_add(track.description.len()))
            .and_then(|n| n.checked_add(crate::INPUT_CAPACITY))
            .is_none_or(|n| n > METADATA_BUDGET)
        {
            return Err(Error::ResourceLimit);
        }
        track
            .packets
            .try_reserve_exact(sizes.count)
            .map_err(|_| Error::ResourceLimit)?;
        let first = stsc.entry(&raw, 0)?;
        if u32be(first, 0)? != 1 || u32be(first, 4)? == 0 || u32be(first, 8)? != 1 {
            return Err(Error::Invalid);
        }
        let per_chunk = u32be(first, 4)?;
        let offset = if wide {
            u64be(offsets.entry(&raw, 0)?, 0)?
        } else {
            u32be(offsets.entry(&raw, 0)?, 0)? as u64
        };
        Ok(Self {
            raw,
            file_len,
            sizes,
            fixed_size,
            offsets,
            stsc,
            stts,
            ctts,
            ctts_signed,
            stss,
            sample_at: 0,
            chunk_at: 0,
            chunk_run_at: 0,
            sample_in_chunk: 0,
            per_chunk,
            offset,
            dts: 0,
            stts_at: 0,
            stts_remaining: 0,
            stts_value: 0,
            ctts_at: 0,
            ctts_remaining: 0,
            ctts_value: 0,
            stss_at: 0,
        })
    }

    fn next_run(
        raw: &[u8],
        table: TableRef,
        at: &mut usize,
        remaining: &mut u32,
        value: &mut u32,
    ) -> Result<u32, Error> {
        if *remaining == 0 {
            let entry = table.entry(raw, *at)?;
            *remaining = u32be(entry, 0)?;
            *value = u32be(entry, 4)?;
            if *remaining == 0 {
                return Err(Error::Invalid);
            }
            *at += 1;
        }
        *remaining -= 1;
        Ok(*value)
    }

    pub fn advance(&mut self, track: &mut Track, credit: u32) -> Result<bool, Error> {
        for _ in 0..credit.clamp(1, 64) {
            if self.sample_at == self.sizes.count {
                if self.chunk_at + 1 != self.offsets.count || self.sample_in_chunk != self.per_chunk
                {
                    return Err(Error::Invalid);
                }
                return Ok(true);
            }
            if self.sample_in_chunk == self.per_chunk {
                self.chunk_at += 1;
                if self.chunk_at >= self.offsets.count {
                    return Err(Error::Invalid);
                }
                self.sample_in_chunk = 0;
                if self.chunk_run_at + 1 < self.stsc.count {
                    let next = self.stsc.entry(&self.raw, self.chunk_run_at + 1)?;
                    if u32be(next, 0)? as usize == self.chunk_at + 1 {
                        self.chunk_run_at += 1;
                        self.per_chunk = u32be(next, 4)?;
                        if self.per_chunk == 0 || u32be(next, 8)? != 1 {
                            return Err(Error::Invalid);
                        }
                    }
                }
                let entry = self.offsets.entry(&self.raw, self.chunk_at)?;
                self.offset = if self.offsets.width == 8 {
                    u64be(entry, 0)?
                } else {
                    u32be(entry, 0)? as u64
                };
            }
            let size = if self.fixed_size != 0 {
                self.fixed_size
            } else {
                u32be(self.sizes.entry(&self.raw, self.sample_at)?, 0)?
            };
            if size == 0 || size > PACKET_BUDGET {
                return Err(Error::ResourceLimit);
            }
            let end = self
                .offset
                .checked_add(size as u64)
                .ok_or(Error::Overflow)?;
            if end > self.file_len {
                return Err(Error::Truncated);
            }
            let duration = Self::next_run(
                &self.raw,
                self.stts,
                &mut self.stts_at,
                &mut self.stts_remaining,
                &mut self.stts_value,
            )?;
            let delta = if let Some(ctts) = self.ctts {
                let raw = Self::next_run(
                    &self.raw,
                    ctts,
                    &mut self.ctts_at,
                    &mut self.ctts_remaining,
                    &mut self.ctts_value,
                )?;
                if self.ctts_signed {
                    raw as i32 as i64
                } else {
                    raw as i64
                }
            } else {
                0
            };
            let pts = self
                .dts
                .checked_add(delta)
                .and_then(|n| n.checked_add(track.edit_shift))
                .ok_or(Error::Overflow)?;
            let dts = self
                .dts
                .checked_add(track.edit_shift)
                .ok_or(Error::Overflow)?;
            let sample_num = self.sample_at as u32 + 1;
            let key = if let Some(stss) = self.stss {
                if self.stss_at >= stss.count {
                    false
                } else {
                    let entry = stss.entry(&self.raw, self.stss_at)?;
                    let key_num = u32be(entry, 0)?;
                    if key_num < sample_num || key_num == 0 {
                        return Err(Error::Invalid);
                    }
                    if key_num == sample_num {
                        self.stss_at += 1;
                        true
                    } else {
                        false
                    }
                }
            } else {
                true
            };
            track.packets.push(Packet {
                offset: self.offset,
                size,
                dts,
                pts,
                duration: u64::from(duration),
                key,
            });
            self.dts = self
                .dts
                .checked_add(duration as i64)
                .ok_or(Error::Overflow)?;
            self.offset = end;
            self.sample_at += 1;
            self.sample_in_chunk += 1;
        }
        if self.sample_at == self.sizes.count {
            if self.chunk_at + 1 != self.offsets.count || self.sample_in_chunk != self.per_chunk {
                return Err(Error::Invalid);
            }
            Ok(true)
        } else {
            Ok(false)
        }
    }
}
