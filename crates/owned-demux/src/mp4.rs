// SPDX-License-Identifier: MIT
// Copyright (c) 2026 PiesP

use crate::{Error, Packet, Track, MAX_SAMPLES, METADATA_BUDGET, PACKET_BUDGET};

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

fn child<'a>(data: &'a [u8], kind: [u8; 4]) -> Result<Option<&'a [u8]>, Error> {
    Ok(atoms(data)?
        .into_iter()
        .find(|atom| atom.kind == kind)
        .map(|atom| atom.data))
}
fn required<'a>(data: &'a [u8], kind: [u8; 4]) -> Result<&'a [u8], Error> {
    child(data, kind)?.ok_or(Error::Unsupported)
}

fn records(data: &[u8], width: usize) -> Result<usize, Error> {
    let count = u32be(data, 4)? as usize;
    if count > MAX_SAMPLES
        || count.checked_mul(width).ok_or(Error::Overflow)? > METADATA_BUDGET
        || data.len() < 8 + count * width
    {
        return Err(Error::ResourceLimit);
    }
    Ok(count)
}

fn pairs(data: &[u8]) -> Result<Vec<(u32, u32)>, Error> {
    let count = records(data, 8)?;
    let mut result = Vec::with_capacity(count);
    for i in 0..count {
        let at = 8 + i * 8;
        let n = u32be(data, at)?;
        let v = u32be(data, at + 4)?;
        if n == 0 {
            return Err(Error::Invalid);
        }
        result.push((n, v));
    }
    Ok(result)
}

fn sample_description(data: &[u8]) -> Result<([u8; 4], u32, u32, Vec<u8>), Error> {
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
    Ok((codec, width, height, description.to_vec()))
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

struct Runs<'a> {
    pairs: &'a [(u32, u32)],
    index: usize,
    remaining: u32,
    value: u32,
}
impl<'a> Runs<'a> {
    fn new(pairs: &'a [(u32, u32)]) -> Result<Self, Error> {
        let (remaining, value) = *pairs.first().ok_or(Error::Invalid)?;
        Ok(Self {
            pairs,
            index: 0,
            remaining,
            value,
        })
    }
    fn next(&mut self) -> Result<u32, Error> {
        if self.remaining == 0 {
            self.index += 1;
            let (count, value) = *self.pairs.get(self.index).ok_or(Error::Invalid)?;
            self.remaining = count;
            self.value = value;
        }
        self.remaining -= 1;
        Ok(self.value)
    }
}

fn sample_sizes(data: &[u8]) -> Result<Vec<u32>, Error> {
    let default = u32be(data, 4)?;
    let count = u32be(data, 8)? as usize;
    if count > MAX_SAMPLES || count * 4 > METADATA_BUDGET {
        return Err(Error::ResourceLimit);
    }
    if default != 0 {
        return Ok(vec![default; count]);
    }
    if data.len() < 12 + count * 4 {
        return Err(Error::Truncated);
    }
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        out.push(u32be(data, 12 + i * 4)?);
    }
    Ok(out)
}

fn chunk_offsets(data: &[u8], wide: bool) -> Result<Vec<u64>, Error> {
    let width = if wide { 8 } else { 4 };
    let count = records(data, width)?;
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        out.push(if wide {
            u64be(data, 8 + i * width)?
        } else {
            u32be(data, 8 + i * width)? as u64
        });
    }
    Ok(out)
}

fn key_samples(data: Option<&[u8]>, count: usize) -> Result<Vec<u32>, Error> {
    let Some(data) = data else {
        return Ok(Vec::new());
    };
    let total = records(data, 4)?;
    let mut keys = Vec::with_capacity(total);
    for i in 0..total {
        let value = u32be(data, 8 + i * 4)?;
        if value == 0 || value as usize > count || keys.last().is_some_and(|last| *last >= value) {
            return Err(Error::Invalid);
        }
        keys.push(value);
    }
    Ok(keys)
}

fn sample_to_chunk(data: &[u8], chunks: usize) -> Result<Vec<(u32, u32)>, Error> {
    let count = records(data, 12)?;
    let mut entries = Vec::with_capacity(count);
    for i in 0..count {
        let at = 8 + i * 12;
        let first = u32be(data, at)?;
        let per_chunk = u32be(data, at + 4)?;
        let description = u32be(data, at + 8)?;
        if first == 0
            || first as usize > chunks
            || per_chunk == 0
            || description != 1
            || entries.last().is_some_and(|(prior, _)| *prior >= first)
        {
            return Err(Error::Invalid);
        }
        entries.push((first, per_chunk));
    }
    if entries.first().is_none_or(|(first, _)| *first != 1) {
        return Err(Error::Invalid);
    }
    Ok(entries)
}

fn build_packets(stbl: &[u8], file_len: u64, moov_bytes: usize) -> Result<Vec<Packet>, Error> {
    let sizes = sample_sizes(required(stbl, *b"stsz")?)?;
    let count = sizes.len();
    if count == 0 {
        return Err(Error::Unsupported);
    }
    let offsets = if let Some(co64) = child(stbl, *b"co64")? {
        chunk_offsets(co64, true)?
    } else {
        chunk_offsets(required(stbl, *b"stco")?, false)?
    };
    let chunks = sample_to_chunk(required(stbl, *b"stsc")?, offsets.len())?;
    let timing = pairs(required(stbl, *b"stts")?)?;
    let composition = child(stbl, *b"ctts")?.map(pairs).transpose()?;
    let composition_signed = child(stbl, *b"ctts")?.is_some_and(|bytes| bytes.first() == Some(&1));
    let keys = key_samples(child(stbl, *b"stss")?, count)?;
    let reserve = count
        .checked_mul(std::mem::size_of::<Packet>())
        .ok_or(Error::Overflow)?;
    if reserve > METADATA_BUDGET.saturating_sub(moov_bytes) {
        return Err(Error::ResourceLimit);
    }
    let mut packets = Vec::with_capacity(count);
    let mut dts = 0i64;
    let mut clock = Runs::new(&timing)?;
    let mut pts_offset = composition.as_deref().map(Runs::new).transpose()?;
    let mut key_at = 0usize;
    let mut chunk_run_at = 0usize;
    let mut sample_at = 0usize;
    for (chunk_number, base) in offsets.iter().enumerate() {
        while chunk_run_at + 1 < chunks.len()
            && chunks[chunk_run_at + 1].0 as usize <= chunk_number + 1
        {
            chunk_run_at += 1;
        }
        let per_chunk = chunks[chunk_run_at].1 as usize;
        let mut offset = *base;
        for _ in 0..per_chunk {
            if sample_at == count {
                return Err(Error::Invalid);
            }
            let size = sizes[sample_at];
            if size == 0 || size > PACKET_BUDGET {
                return Err(Error::ResourceLimit);
            }
            let end = offset.checked_add(size as u64).ok_or(Error::Overflow)?;
            if end > file_len {
                return Err(Error::Truncated);
            }
            let duration = clock.next()?;
            let delta = if let Some(runs) = pts_offset.as_mut() {
                let value = runs.next()?;
                if composition_signed {
                    value as i32 as i64
                } else {
                    value as i64
                }
            } else {
                0
            };
            let pts = dts.checked_add(delta).ok_or(Error::Overflow)?;
            let sample_number = sample_at as u32 + 1;
            while key_at < keys.len() && keys[key_at] < sample_number {
                key_at += 1;
            }
            let is_key = keys.is_empty() || keys.get(key_at) == Some(&sample_number);
            packets.push(Packet {
                offset,
                size,
                dts,
                pts,
                duration,
                key: is_key,
            });
            dts = dts.checked_add(duration as i64).ok_or(Error::Overflow)?;
            offset = end;
            sample_at += 1;
        }
    }
    if sample_at != count {
        return Err(Error::Invalid);
    }
    Ok(packets)
}

pub fn parse_moov(data: &[u8], file_len: u64) -> Result<Track, Error> {
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
        let (codec, width, height, description) = sample_description(required(stbl, *b"stsd")?)?;
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
        let mut packets =
            if child(stbl, *b"stsz")?.is_some_and(|table| u32be(table, 8).unwrap_or(0) > 0) {
                build_packets(stbl, file_len, data.len())?
            } else if defaults.is_some() {
                Vec::new()
            } else {
                return Err(Error::Unsupported);
            };
        for packet in &mut packets {
            packet.dts = packet.dts.checked_add(edit_shift).ok_or(Error::Overflow)?;
            packet.pts = packet.pts.checked_add(edit_shift).ok_or(Error::Overflow)?;
        }
        return Ok(Track {
            track_id,
            codec,
            width,
            height,
            timescale,
            duration,
            rotation,
            description,
            packets,
            fragment_default_duration,
            fragment_default_size,
            fragment_default_flags,
            edit_shift,
        });
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

pub fn append_moof(
    data: &[u8],
    box_start: u64,
    file_len: u64,
    track: &mut Track,
) -> Result<(), Error> {
    let mut implicit_base = box_start;
    for traf in atoms(data)?
        .into_iter()
        .filter(|atom| atom.kind == *b"traf")
    {
        let tfhd = required(traf.data, *b"tfhd")?;
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
        let duration = if flags & 0x000008 != 0 {
            let v = u32be(tfhd, at)?;
            at += 4;
            v
        } else {
            track.fragment_default_duration
        };
        let size = if flags & 0x000010 != 0 {
            let v = u32be(tfhd, at)?;
            at += 4;
            v
        } else {
            track.fragment_default_size
        };
        let sample_flags = if flags & 0x000020 != 0 {
            u32be(tfhd, at)?
        } else {
            track.fragment_default_flags
        };
        let base = explicit_base.unwrap_or(if flags & 0x020000 != 0 {
            box_start
        } else {
            implicit_base
        });
        let tfdt = required(traf.data, *b"tfdt")?;
        let mut dts = if tfdt.first() == Some(&1) {
            u64be(tfdt, 4)?
        } else {
            u32be(tfdt, 4)? as u64
        };
        let fragment_start = track.packets.len();
        let mut data_end = base;
        for trun in atoms(traf.data)?
            .into_iter()
            .filter(|atom| atom.kind == *b"trun")
        {
            let trun_flags = u32be(trun.data, 0)? & 0x00ff_ffff;
            let count = u32be(trun.data, 4)? as usize;
            if count > MAX_SAMPLES
                || track.packets.len().saturating_add(count) > MAX_SAMPLES
                || track.packets.len().saturating_add(count) * std::mem::size_of::<Packet>()
                    > METADATA_BUDGET
            {
                return Err(Error::ResourceLimit);
            }
            let mut pos = 8usize;
            let data_offset = if trun_flags & 0x000001 != 0 {
                let v = i32be(trun.data, pos)?;
                pos += 4;
                Some(v)
            } else {
                None
            };
            let first_flags = if trun_flags & 0x000004 != 0 {
                let v = u32be(trun.data, pos)?;
                pos += 4;
                Some(v)
            } else {
                None
            };
            let mut offset = if let Some(delta) = data_offset {
                let absolute = (base as i128) + (delta as i128);
                if absolute < 0 || absolute > file_len as i128 {
                    return Err(Error::Invalid);
                }
                absolute as u64
            } else {
                data_end
            };
            for index in 0..count {
                let duration = if trun_flags & 0x000100 != 0 {
                    let v = u32be(trun.data, pos)?;
                    pos += 4;
                    v
                } else {
                    duration
                };
                let size = if trun_flags & 0x000200 != 0 {
                    let v = u32be(trun.data, pos)?;
                    pos += 4;
                    v
                } else {
                    size
                };
                let flags = if trun_flags & 0x000400 != 0 {
                    let v = u32be(trun.data, pos)?;
                    pos += 4;
                    v
                } else if index == 0 {
                    first_flags.unwrap_or(sample_flags)
                } else {
                    sample_flags
                };
                let composition = if trun_flags & 0x000800 != 0 {
                    let v = u32be(trun.data, pos)?;
                    pos += 4;
                    if trun.data.first() == Some(&1) {
                        v as i32 as i64
                    } else {
                        v as i64
                    }
                } else {
                    0
                };
                let end = offset.checked_add(size as u64).ok_or(Error::Overflow)?;
                if size == 0 || size > PACKET_BUDGET || end > file_len {
                    return Err(Error::ResourceLimit);
                }
                let packet_dts = i64::try_from(dts)
                    .map_err(|_| Error::Overflow)?
                    .checked_add(track.edit_shift)
                    .ok_or(Error::Overflow)?;
                let pts = packet_dts.checked_add(composition).ok_or(Error::Overflow)?;
                if id == track.track_id {
                    track.packets.push(Packet {
                        offset,
                        size,
                        dts: packet_dts,
                        pts,
                        duration,
                        key: flags & 0x00010000 == 0,
                    });
                }
                dts = dts.checked_add(duration as u64).ok_or(Error::Overflow)?;
                offset = end;
            }
            data_end = offset;
        }
        if id == track.track_id && track.packets.len() > fragment_start + 1 {
            let mut presentation: Vec<usize> = (fragment_start..track.packets.len()).collect();
            presentation.sort_unstable_by_key(|index| track.packets[*index].pts);
            for pair in presentation.windows(2) {
                let next = track.packets[pair[1]].pts;
                let current = &mut track.packets[pair[0]];
                current.duration =
                    u32::try_from(next.checked_sub(current.pts).ok_or(Error::Overflow)?)
                        .map_err(|_| Error::Overflow)?;
            }
        }
        implicit_base = data_end;
    }
    Ok(())
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
        let timing = [(2, 100)];
        let mut run = Runs::new(&timing).unwrap();
        assert_eq!(run.next(), Ok(100));
        assert_eq!(run.next(), Ok(100));
        assert_eq!(run.next(), Err(Error::Invalid));
        let neg = 0xffff_ff9c_u32;
        assert_eq!(neg as i32 as i64, -100);
    }
}
