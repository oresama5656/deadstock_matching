import Encoding from 'encoding-japanese';
import Papa from 'papaparse';

export const readCJISFile = (file) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const codes = new Uint8Array(e.target.result);
            // Detect encoding or force Shift_JIS
            const encoding = Encoding.detect(codes);
            const unicodeString = Encoding.convert(codes, {
                to: 'UNICODE',
                from: encoding || 'SJIS', // Fallback to SJIS
                type: 'string',
            });
            resolve(unicodeString);
        };
        reader.onerror = (e) => reject(e);
        reader.readAsArrayBuffer(file);
    });
};

export const parseCSV = (content) => {
    // Use PapaParse for robust CSV parsing
    const results = Papa.parse(content, {
        header: false,
        skipEmptyLines: true,
    });
    return results.data;
};
