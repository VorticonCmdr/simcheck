function convertFloat32Arrays(obj) {
    if (obj instanceof Float32Array) {
        return Array.from(obj);
    } else if (Array.isArray(obj)) {
        return obj.map(item => convertFloat32Arrays(item));
    } else if (typeof obj === 'object' && obj !== null) {
        return Object.fromEntries(Object.entries(obj).map(
            ([key, value]) => [key, convertFloat32Arrays(value)]
        ));
    } else {
        return obj;
    }
}

// Function to stringify an array of objects
function stringifyArray(array) {
    const convertedArray = array.map(obj => convertFloat32Arrays(obj));
    return JSON.stringify(convertedArray);
}

// Function to compress a string using the Compression Streams API
async function compressString(input) {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(data);
    writer.close();
    const compressedStream = cs.readable;
    const reader = compressedStream.getReader();
    const chunks = [];
    let done, value;
    while ({ done, value } = await reader.read(), !done) {
        chunks.push(value);
    }
    return new Blob(chunks);
}

// Function to download compressed data
function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Example usage
async function handleDownload(array, filenameWithoutExtension) {
    const jsonString = stringifyArray(array);
    const compressedBlob = await compressString(jsonString);
    downloadBlob(compressedBlob, `${filenameWithoutExtension}.json.gz`);
}

export { handleDownload };
