#include <avif/avif.h>
#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using emscripten::val;

constexpr uint64_t kTimescale = 1000;
constexpr int kMaxDimension = 16384;

[[noreturn]] void throwInvalidArgument(const std::string& message)
{
    throw std::invalid_argument(message);
}

void checkResult(avifResult result, const char* operation)
{
    if (result != AVIF_RESULT_OK) {
        throw std::runtime_error(std::string(operation) + " failed: " + avifResultToString(result));
    }
}

std::vector<uint8_t> copyFrame(const val& frame, size_t expectedByteLength)
{
    if (frame.isNull() || frame.isUndefined()) {
        throwInvalidArgument("AVIF frame must be a Uint8Array");
    }

    const size_t byteLength = frame["byteLength"].as<size_t>();
    if (byteLength != expectedByteLength) {
        throwInvalidArgument("AVIF frame has an unexpected byte length");
    }

    return emscripten::convertJSArrayToNumberVector<uint8_t>(frame);
}

class AvifAnimationEncoder {
public:
    AvifAnimationEncoder(int width, int height, int channels, int quality, int speed, int repetitionCount)
        : width_(width)
        , height_(height)
        , channels_(channels)
    {
        if (width <= 0 || height <= 0 || width > kMaxDimension || height > kMaxDimension) {
            throwInvalidArgument("AVIF dimensions are outside the supported range");
        }
        if (channels != 3 && channels != 4) {
            throwInvalidArgument("AVIF input must contain RGB or RGBA pixels");
        }
        if (quality < AVIF_QUALITY_WORST || quality > AVIF_QUALITY_BEST) {
            throwInvalidArgument("AVIF quality is outside the supported range");
        }
        if (speed < AVIF_SPEED_SLOWEST || speed > AVIF_SPEED_FASTEST) {
            throwInvalidArgument("AVIF speed is outside the supported range");
        }

        encoder_ = avifEncoderCreate();
        if (encoder_ == nullptr) {
            throw std::runtime_error("AVIF encoder allocation failed");
        }

        encoder_->codecChoice = AVIF_CODEC_CHOICE_AOM;
        encoder_->maxThreads = 1;
        encoder_->speed = speed;
        encoder_->timescale = kTimescale;
        encoder_->repetitionCount = repetitionCount;
        encoder_->quality = quality;
        encoder_->qualityAlpha = quality;
    }

    ~AvifAnimationEncoder()
    {
        destroy();
    }

    void addFrame(const val& frame, uint64_t durationInTimescales)
    {
        if (encoder_ == nullptr) {
            throw std::runtime_error("AVIF encoder is already finalized");
        }
        if (durationInTimescales == 0 || durationInTimescales > std::numeric_limits<uint64_t>::max() / kTimescale) {
            destroy();
            throwInvalidArgument("AVIF frame durations must be positive and finite");
        }

        const size_t pixelCount = static_cast<size_t>(width_) * static_cast<size_t>(height_);
        const size_t expectedByteLength = pixelCount * static_cast<size_t>(channels_);
        std::vector<uint8_t> pixels;
        try {
            pixels = copyFrame(frame, expectedByteLength);
        } catch (...) {
            destroy();
            throw;
        }

        avifImage* image = avifImageCreate(width_, height_, 8, AVIF_PIXEL_FORMAT_YUV444);
        if (image == nullptr) {
            destroy();
            throw std::runtime_error("AVIF image allocation failed");
        }

        avifRGBImage rgb;
        avifRGBImageSetDefaults(&rgb, image);
        rgb.format = channels_ == 4 ? AVIF_RGB_FORMAT_RGBA : AVIF_RGB_FORMAT_RGB;
        rgb.depth = 8;
        rgb.pixels = pixels.data();
        rgb.rowBytes = static_cast<uint32_t>(width_ * channels_);

        const avifResult conversionResult = avifImageRGBToYUV(image, &rgb);
        if (conversionResult != AVIF_RESULT_OK) {
            avifImageDestroy(image);
            destroy();
            checkResult(conversionResult, "AVIF RGB conversion");
        }

        const avifResult addResult = avifEncoderAddImage(
            encoder_, image, durationInTimescales, AVIF_ADD_IMAGE_FLAG_NONE);
        avifImageDestroy(image);
        if (addResult != AVIF_RESULT_OK) {
            destroy();
            checkResult(addResult, "AVIF frame encoding");
        }
    }

    val finish()
    {
        if (encoder_ == nullptr) {
            throw std::runtime_error("AVIF encoder is already finalized");
        }

        avifRWData output = AVIF_DATA_EMPTY;
        const avifResult finishResult = avifEncoderFinish(encoder_, &output);
        if (finishResult != AVIF_RESULT_OK) {
            destroy();
            checkResult(finishResult, "AVIF sequence finalization");
        }

        val outputView = val::global("Uint8Array").new_(emscripten::typed_memory_view(output.size, output.data));
        val outputCopy = outputView.call<val>("slice");
        avifRWDataFree(&output);
        destroy();
        return outputCopy;
    }

private:
    void destroy()
    {
        if (encoder_ != nullptr) {
            avifEncoderDestroy(encoder_);
            encoder_ = nullptr;
        }
    }

    int width_;
    int height_;
    int channels_;
    avifEncoder* encoder_ = nullptr;
};

} // namespace

EMSCRIPTEN_BINDINGS(avif_encoder)
{
    emscripten::class_<AvifAnimationEncoder>("AvifAnimationEncoder")
        .constructor<int, int, int, int, int, int>()
        .function("addFrame", &AvifAnimationEncoder::addFrame)
        .function("finish", &AvifAnimationEncoder::finish);
}
