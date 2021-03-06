/*
 * Copyright 2017-2019 Marcel Ball
 * https://github.com/Marus/cortex-debug
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without
 * limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
 * Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
 * TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 * CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */

import { PeripheralRegisterNode } from './nodes/register-node';
import { PeripheralClusterNode } from './nodes/cluster-node';
import { PeripheralNode } from './nodes/peripheral-node';
import { PeripheralFieldNode, EnumerationMap, EnumeratedValue, FieldOptions } from './nodes/field-node';
import { parseInteger, parseDimIndex, AccessType } from './util';

/* eslint-disable @typescript-eslint/no-explicit-any */

const accessTypeFromString = (type: string): AccessType => {
    switch (type) {
        case 'write-only':
        case 'writeOnce': {
            return AccessType.WriteOnly;
        }
        case 'read-write':
        case 'read-writeOnce': {
            return AccessType.ReadWrite;
        }
        // case 'read-only',
        default: {
            return AccessType.ReadOnly;
        }
    }
};

export class SVDParser {
    private static enumTypeValuesMap: { [key: string]: any } = {};
    private static peripheralRegisterMap: { [key: string]: any } = {};

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public static async parseSVD(data: any): Promise<PeripheralNode[]> {
        SVDParser.enumTypeValuesMap = {};
        SVDParser.peripheralRegisterMap = {};
        const peripheralMap: { [key: string]: any } = {};
        const defaultOptions = {
            accessType: AccessType.ReadWrite,
            size: 32,
            resetValue: 0x0
        };

        if (data.device.resetValue) {
            defaultOptions.resetValue = parseInteger(data.device.resetValue[0]) || 0;
        }
        if (data.device.size) {
            defaultOptions.size = parseInteger(data.device.size[0]) || 0;
        }
        if (data.device.access) {
            defaultOptions.accessType = accessTypeFromString(data.device.access[0]);
        }

        data.device.peripherals[0].peripheral.forEach((element: any) => {
            const name = element.name[0];
            peripheralMap[name] = element;
        });

        for (const key in peripheralMap) {
            const element = peripheralMap[key];
            if (element.$ && element.$.derivedFrom) {
                const base = peripheralMap[element.$.derivedFrom];
                peripheralMap[key] = { ...base, ...element };
            }
        }

        const peripherials = [];
        for (const key in peripheralMap) {
            peripherials.push(SVDParser.parsePeripheral(peripheralMap[key]));
        }

        peripherials.sort(PeripheralNode.compare);

        for (const p of peripherials) {
            p.markAddresses();
        }

        return peripherials;
    }

    private static cleanupDescription(input: string): string {
        return input.replace('\r', '').replace(/\n\s*/g, ' ');
    }

    private static parseFields(fieldInfo: any[], parent: PeripheralRegisterNode): PeripheralFieldNode[] {
        const fields: PeripheralFieldNode[] = [];

        if (fieldInfo === undefined) {
            return fields;
        }

        fieldInfo.map((f) => {
            let offset;
            let width;
            const description = this.cleanupDescription(f.description ? f.description[0] : '');

            if (f.bitOffset && f.bitWidth) {
                offset = parseInteger(f.bitOffset[0]);
                width = parseInteger(f.bitWidth[0]);
            } else if (f.bitRange) {
                let range = f.bitRange[0];
                range = range.substring(1, range.length - 1);
                range = range.split(':');
                const end = parseInteger(range[0]);
                const start = parseInteger(range[1]);

                if (end && start) {
                    width = end - start + 1;
                    offset = start;
                }
            } else if (f.msb && f.lsb) {
                const msb = parseInteger(f.msb[0]);
                const lsb = parseInteger(f.lsb[0]);

                if (msb && lsb) {
                    width = msb - lsb + 1;
                    offset = lsb;
                }
            } else {
                throw new Error(`Unable to parse SVD file: field ${f.name[0]} must have either bitOffset and bitWidth elements, bitRange Element, or msb and lsb elements.`);
            }

            let valueMap: EnumerationMap | undefined;
            if (f.enumeratedValues) {
                valueMap = {};
                const eValues = f.enumeratedValues[0];
                if (eValues.$ && eValues.$.derivedFrom) {
                    const found = SVDParser.enumTypeValuesMap[eValues.$.derivedFrom];
                    if (!found) {
                        throw new Error(`Invalid derivedFrom=${eValues.$.derivedFrom} for enumeratedValues of field ${f.name[0]}`);
                    }
                    valueMap = found;
                } else {
                    eValues.enumeratedValue.map((ev: any) => {
                        if (ev.value && ev.value.length > 0) {
                            const evname = ev.name[0];
                            const evdesc = this.cleanupDescription(ev.description ? ev.description[0] : '');
                            const val = ev.value[0].toLowerCase();
                            const evvalue = parseInteger(val);

                            if (valueMap && evvalue) {
                                valueMap[evvalue] = new EnumeratedValue(evname, evdesc, evvalue);
                            }
                        }
                    });

                    // According to the SVD spec/schema, I am not sure any scope applies. Seems like everything is in a global name space
                    // No make sense but how I am interpreting it for now. Easy to make it scope based but then why allow referencing
                    // other peripherals. Global scope it is. Overrides dups from previous definitions!!!
                    if (eValues.name && eValues.name[0]) {
                        let evName = eValues.name[0];
                        for (const prefix of [undefined, f.name[0], parent.name, parent.parent.name]) {
                            evName = prefix ? prefix + '.' + evName : evName;
                            SVDParser.enumTypeValuesMap[evName] = valueMap;
                        }
                    }
                }
            }

            const baseOptions: FieldOptions = {
                name: f.name[0],
                description: description,
                offset: offset || 0,
                width: width || 0,
                enumeration: valueMap
            };

            if (f.dim) {
                if (!f.dimIncrement) { throw new Error(`Unable to parse SVD file: field ${f.name[0]} has dim element, with no dimIncrement element.`); }

                const count = parseInteger(f.dim[0]);
                if (count) {
                    const increment = parseInteger(f.dimIncrement[0]);
                    let index = [];
                    if (f.dimIndex) {
                        index = parseDimIndex(f.dimIndex[0], count);
                    } else {
                        for (let i = 0; i < count; i++) { index.push(`${i}`); }
                    }

                    const namebase: string = f.name[0];
                    const offsetbase = offset;

                    if (offsetbase && increment) {
                        for (let i = 0; i < count; i++) {
                            const name = namebase.replace('%s', index[i]);
                            fields.push(new PeripheralFieldNode(parent, { ...baseOptions, name: name, offset: offsetbase + (increment * i) }));
                        }
                    }
                }
            } else {
                fields.push(new PeripheralFieldNode(parent, { ...baseOptions }));
            }
        });

        return fields;
    }

    private static parseRegisters(regInfo_: any[], parent: PeripheralNode | PeripheralClusterNode): PeripheralRegisterNode[] {
        const regInfo = [...regInfo_];      // Make a shallow copy,. we will work on this
        const registers: PeripheralRegisterNode[] = [];

        const localRegisterMap: { [key: string]: any } = {};
        for (const r of regInfo) {
            const nm = r.name[0];
            localRegisterMap[nm] = r;
            SVDParser.peripheralRegisterMap[parent.name + '.' + nm] = r;
        }

        // It is wierd to iterate this way but it can handle forward references, are they legal? not sure
        // Or we could have done this work in the loop above. Not the best way, but it is more resilient to
        // concatenate elements and re-parse. We are patching at XML level rather than object level
        let ix = 0;
        for (const r of regInfo) {
            const derivedFrom = r.$ ? r.$.derivedFrom : '';
            if (derivedFrom) {
                const nm = r.name[0];
                const from = localRegisterMap[derivedFrom] || SVDParser.peripheralRegisterMap[derivedFrom];
                if (!from) {
                    throw new Error(`SVD error: Invalid 'derivedFrom' "${derivedFrom}" for register "${nm}"`);
                }
                // We are supposed to preserve all but the addressOffseet, but the following should work
                const combined = { ...from, ...r };
                delete combined.$.derivedFrom;          // No need to keep this anymore
                combined.$._derivedFrom = derivedFrom;  // Save a backup for debugging
                localRegisterMap[nm] = combined;
                SVDParser.peripheralRegisterMap[parent.name + '.' + nm] = combined;
                regInfo[ix] = combined;
            }
            ix++;
        }

        for (const r of regInfo) {
            const baseOptions: any = {};
            if (r.access) {
                baseOptions.accessType = accessTypeFromString(r.access[0]);
            }
            if (r.size) {
                baseOptions.size = parseInteger(r.size[0]);
            }
            if (r.resetValue) {
                baseOptions.resetValue = parseInteger(r.resetValue[0]);
            }

            if (r.dim) {
                if (!r.dimIncrement) { throw new Error(`Unable to parse SVD file: register ${r.name[0]} has dim element, with no dimIncrement element.`); }

                const count = parseInteger(r.dim[0]);
                const increment = parseInteger(r.dimIncrement[0]);

                if (count && increment) {
                    let index = [];
                    if (r.dimIndex) {
                        index = parseDimIndex(r.dimIndex[0], count);
                    } else {
                        for (let i = 0; i < count; i++) { index.push(`${i}`); }
                    }

                    const namebase: string = r.name[0];
                    const descbase: string = this.cleanupDescription(r.description ? r.description[0] : '');
                    const offsetbase = parseInteger(r.addressOffset[0]);

                    if (offsetbase) {
                        for (let i = 0; i < count; i++) {
                            const name = namebase.replace('%s', index[i]);
                            const description = descbase.replace('%s', index[i]);

                            const register = new PeripheralRegisterNode(parent, {
                                ...baseOptions,
                                name: name,
                                description: description,
                                addressOffset: offsetbase + (increment * i)
                            });
                            if (r.fields && r.fields.length === 1) {
                                SVDParser.parseFields(r.fields[0].field, register);
                            }
                            registers.push(register);
                        }
                    }
                }
            } else {
                const description = this.cleanupDescription(r.description ? r.description[0] : '');
                const register = new PeripheralRegisterNode(parent, {
                    ...baseOptions,
                    name: r.name[0],
                    description: description,
                    addressOffset: parseInteger(r.addressOffset[0])
                });
                if (r.fields && r.fields.length === 1) {
                    SVDParser.parseFields(r.fields[0].field, register);
                }
                registers.push(register);
            }
        }

        registers.sort((a, b) => {
            if (a.offset < b.offset) { return -1; } else if (a.offset > b.offset) { return 1; } else { return 0; }
        });

        return registers;
    }

    private static parseClusters(clusterInfo: any, parent: PeripheralNode): PeripheralClusterNode[] {
        const clusters: PeripheralClusterNode[] = [];

        if (!clusterInfo) { return []; }

        clusterInfo.forEach((c:any) => {
            const baseOptions: any = {};
            if (c.access) {
                baseOptions.accessType = accessTypeFromString(c.access[0]);
            }
            if (c.size) {
                baseOptions.size = parseInteger(c.size[0]);
            }
            if (c.resetValue) {
                baseOptions.resetValue = parseInteger(c.resetValue);
            }

            if (c.dim) {
                if (!c.dimIncrement) { throw new Error(`Unable to parse SVD file: cluster ${c.name[0]} has dim element, with no dimIncrement element.`); }

                const count = parseInteger(c.dim[0]);
                const increment = parseInteger(c.dimIncrement[0]);

                if (count && increment) {
                    let index = [];
                    if (c.dimIndex) {
                        index = parseDimIndex(c.dimIndex[0], count);
                    } else {
                        for (let i = 0; i < count; i++) { index.push(`${i}`); }
                    }

                    const namebase: string = c.name[0];
                    const descbase: string = this.cleanupDescription(c.description ? c.description[0] : '');
                    const offsetbase = parseInteger(c.addressOffset[0]);

                    if (offsetbase) {
                        for (let i = 0; i < count; i++) {
                            const name = namebase.replace('%s', index[i]);
                            const description = descbase.replace('%s', index[i]);
                            const cluster = new PeripheralClusterNode(parent, {
                                ...baseOptions,
                                name: name,
                                description: description,
                                addressOffset: offsetbase + (increment * i)
                            });
                            if (c.register) {
                                SVDParser.parseRegisters(c.register, cluster);
                            }
                            clusters.push(cluster);
                        }
                    }
                }
            } else {
                const description = this.cleanupDescription(c.description ? c.description[0] : '');
                const cluster = new PeripheralClusterNode(parent, {
                    ...baseOptions,
                    name: c.name[0],
                    description: description,
                    addressOffset: parseInteger(c.addressOffset[0])
                });
                if (c.register) {
                    SVDParser.parseRegisters(c.register, cluster);
                    clusters.push(cluster);
                }
            }

        });

        return clusters;
    }

    private static parsePeripheral(p: any): PeripheralNode {
        let totalLength = 0;
        if (p.addressBlock) {
            for (const ab of p.addressBlock) {
                const offset = parseInteger(ab.offset[0]);
                const size = parseInteger(ab.size[0]);
                if (offset !== undefined && size !== undefined) {
                    totalLength = Math.max(totalLength, offset + size);
                }
            }
        }

        const options: any = {
            name: p.name[0],
            baseAddress: parseInteger(p.baseAddress ? p.baseAddress[0] : 0),
            description: this.cleanupDescription(p.description ? p.description[0] : ''),
            totalLength: totalLength
        };

        if (p.access) { options.accessType = accessTypeFromString(p.access[0]); }
        if (p.size) { options.size = parseInteger(p.size[0]); }
        if (p.resetValue) { options.resetValue = parseInteger(p.resetValue[0]); }
        if (p.groupName) { options.groupName = p.groupName[0]; }

        const peripheral = new PeripheralNode(options);

        if (p.registers) {
            if (p.registers[0].register) {
                SVDParser.parseRegisters(p.registers[0].register, peripheral);
            }
            if (p.registers[0].cluster) {
                SVDParser.parseClusters(p.registers[0].cluster, peripheral);
            }
        }

        return peripheral;
    }
}
