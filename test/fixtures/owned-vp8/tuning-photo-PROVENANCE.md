# VP8 v2 tuning photograph

`Landscape, road, clouds.jpg` is a photograph by Digitura, published under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) on
[Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Landscape,_road,_clouds.jpg).
The original file (3831 x 2540 JPEG) is not a repository asset. The pinned
original URL is
`https://upload.wikimedia.org/wikipedia/commons/e/ee/Landscape%2C_road%2C_clouds.jpg`.
Its SHA-256 is
`d3950b277f47453e4bfcbda3028b445cb00b6c64e8b2a9362c512a2ff39fefca`.

The 128 x 96 opaque RGBA tuning input is decoded from that exact file with
FFmpeg `7.1.5-0+deb13u1`:

```sh
ffmpeg -v error -noautorotate -i ORIGINAL.jpg -vf 'scale=128:96:flags=bicubic' -frames:v 1 -f rawvideo -pix_fmt rgba OUTPUT.rgba
```

The decoded 49152-byte RGBA SHA-256 is
`0c752d698e82232c286fc24c210ba7ae08a88318d2ceee607743f5d4817a2255`.
The repository carries only the Base64-encoded decoded input for development
qualification; it is not copied to production assets. This source and its
pixels are distinct from the held-out photograph and video inputs in the
[fixture manifest](../../../docs/experiments/501-owned-vp8-v2-fixtures.json).
