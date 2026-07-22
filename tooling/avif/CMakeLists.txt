cmake_minimum_required(VERSION 3.25)

project(wasm_motion_converter_avif LANGUAGES C CXX)

set(LIBAVIF_SOURCE_DIR "" CACHE PATH "Path to the pinned libavif checkout")
if(NOT LIBAVIF_SOURCE_DIR)
    message(FATAL_ERROR "LIBAVIF_SOURCE_DIR must point to a libavif v1.4.2 checkout")
endif()

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(AVIF_CODEC_AOM LOCAL CACHE STRING "Use the pinned local libaom build" FORCE)
set(AVIF_CODEC_AOM_ENCODE ON CACHE BOOL "" FORCE)
set(AVIF_CODEC_AOM_DECODE OFF CACHE BOOL "" FORCE)
set(AVIF_BUILD_APPS OFF CACHE BOOL "" FORCE)
set(AVIF_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(AVIF_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(AVIF_BUILD_MAN_PAGES OFF CACHE BOOL "" FORCE)
set(AVIF_LIBYUV OFF CACHE STRING "" FORCE)
set(AVIF_ZLIBPNG OFF CACHE STRING "" FORCE)
set(AVIF_JPEG OFF CACHE STRING "" FORCE)
set(AVIF_LIBSHARPYUV OFF CACHE STRING "" FORCE)
set(AVIF_CODEC_DAV1D OFF CACHE STRING "" FORCE)
set(AVIF_CODEC_LIBGAV1 OFF CACHE STRING "" FORCE)
set(AVIF_CODEC_RAV1E OFF CACHE STRING "" FORCE)
set(AVIF_CODEC_SVT OFF CACHE STRING "" FORCE)
set(AVIF_CODEC_AVM OFF CACHE STRING "" FORCE)
set(AOM_TARGET_CPU generic CACHE STRING "Use portable libaom code for browser WASM" FORCE)

add_subdirectory("${LIBAVIF_SOURCE_DIR}" libavif)

add_executable(avif_encoder src/avif-encoder-bindings.cpp)
target_compile_features(avif_encoder PRIVATE cxx_std_17)
target_link_libraries(avif_encoder PRIVATE avif)

target_compile_options(avif_encoder PRIVATE -O2)
target_link_options(
    avif_encoder
    PRIVATE
    --bind
    -fexceptions
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=AvifEncoderModule
    -sENVIRONMENT=web,worker
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=67108864
    -sMAXIMUM_MEMORY=1073741824
    -sFILESYSTEM=0
    -sNO_EXIT_RUNTIME=1
)

set_target_properties(
    avif_encoder
    PROPERTIES
    OUTPUT_NAME "avif-encoder"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_RUNTIME_OUTPUT_DIRECTORY}"
)
