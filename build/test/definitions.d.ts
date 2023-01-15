import { FMember, FPMember } from '../src/types';
export declare type FsFunction = FPMember & FMember;
export declare type Opts = {
    sync?: boolean;
    callback?: boolean;
    promise?: boolean;
};
export declare type Result = {
    error?: RegExp;
    result?: any;
    resultAsError?: any;
};
export declare type TestCase = [FsFunction, any[], Result, any[], Opts?];
export declare type TestCreator = (name: FsFunction, args: any[], result: Result, spans: any[]) => void;
declare const tests: TestCase[];
export default tests;
//# sourceMappingURL=definitions.d.ts.map