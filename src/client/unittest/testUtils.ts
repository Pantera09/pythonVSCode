import {TestFolder, TestsToRun, Tests, TestFile, TestSuite, TestFunction, TestStatus, FlattenedTestFunction, FlattenedTestSuite, CANCELLATION_REASON} from './contracts';
import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as constants from '../common/constants';

let discoveredTests: Tests;

export function displayTestErrorMessage(message: string) {
    vscode.window.showErrorMessage('There was an error in running the unit tests.', constants.Button_Text_Tests_View_Output).then(action => {
        if (action === constants.Button_Text_Tests_View_Output) {
            vscode.commands.executeCommand(constants.Command_Tests_ViewOutput);
        }
    });

}
export function getDiscoveredTests(): Tests {
    return discoveredTests;
}
function storeDiscoveredTests(tests: Tests) {
    discoveredTests = tests;
}

export abstract class BaseTestManager {
    private tests: Tests;
    private _status: TestStatus = TestStatus.Unknown;
    private cancellationTokenSource: vscode.CancellationTokenSource;
    protected get cancellationToken(): vscode.CancellationToken {
        return this.cancellationTokenSource && this.cancellationTokenSource.token;
    }
    public dispose() {
    }
    public get status(): TestStatus {
        return this._status;
    }
    public stop() {
        if (this.cancellationTokenSource) {
            this.cancellationTokenSource.cancel();
        }
    }
    constructor(protected rootDirectory: string, protected outputChannel: vscode.OutputChannel) {
        this._status = TestStatus.Unknown;
    }
    protected stdOut(output: string) {
        output.split(/\r?\n/g).forEach((line, index, lines) => {
            if (index === 0) {
                if (output.startsWith(os.EOL) || lines.length > 1) {
                    return this.outputChannel.appendLine(line);
                }
                return this.outputChannel.append(line);
            }
            if (index === lines.length - 1) {
                return this.outputChannel.append(line);
            }
            this.outputChannel.appendLine(line);
        });
    }
    public reset() {
        this._status = TestStatus.Unknown;
        this.tests = null;
    }
    // public stop(): Promise<any> {
    //     if (this._status === TestStatus.Discovering || this._status === TestStatus.Running) {
    //         return this.stopImpl().then(() => {
    //             this._status = TestStatus.Idle;
    //         }).catch(reason => {
    //             this._status = TestStatus.Error;
    //             return Promise.reject(reason);
    //         });
    //     }
    //     return Promise.resolve();
    // }
    public resetTestResults() {
        if (!this.tests) {
            return;
        }

        resetTestResults(this.tests);
    }
    private createCancellationToken() {
        this.disposeCancellationToken();
        this.cancellationTokenSource = new vscode.CancellationTokenSource();
    }
    private disposeCancellationToken() {
        if (this.cancellationTokenSource) {
            this.cancellationTokenSource.dispose();
        }
        this.cancellationTokenSource = null;
    }
    private discoverTestsPromise: Promise<Tests>;
    discoverTests(ignoreCache: boolean = false): Promise<Tests> {
        if (this.discoverTestsPromise) {
            return this.discoverTestsPromise;
        }

        if (!ignoreCache && this.tests && this.tests.testFunctions.length > 0) {
            this._status = TestStatus.Idle;
            this.resetTestResults();
            return Promise.resolve(this.tests);
        }

        this._status = TestStatus.Discovering;

        this.cancellationTokenSource = new vscode.CancellationTokenSource();
        this.createCancellationToken();
        return this.discoverTestsPromise = this.discoverTestsImpl()
            .then(tests => {
                this.tests = tests;
                this._status = TestStatus.Idle;
                this.resetTestResults();
                this.discoverTestsPromise = null;

                // have errors in Discovering
                let haveErrorsInDiscovering = false;
                tests.testFiles.forEach(file => {
                    if (file.errorsWhenDiscovering && file.errorsWhenDiscovering.length > 0) {
                        haveErrorsInDiscovering = true;
                        this.outputChannel.appendLine('');
                        this.outputChannel.append('#'.repeat(10));
                        this.outputChannel.append(`There was an error in identifying Unit Tests in ${file.nameToRun}`);
                        this.outputChannel.appendLine('#'.repeat(10));
                        this.outputChannel.appendLine(file.errorsWhenDiscovering);
                    }
                });
                if (haveErrorsInDiscovering) {
                    displayTestErrorMessage('There were some errors in disovering unit tests');
                }
                storeDiscoveredTests(tests);
                this.disposeCancellationToken();
                return tests;
            }).catch(reason => {
                this.tests = null;
                this.discoverTestsPromise = null;
                if (this.cancellationToken.isCancellationRequested) {
                    reason = CANCELLATION_REASON;
                    this._status = TestStatus.Idle;
                }
                else {
                    this._status = TestStatus.Error;
                    this.outputChannel.appendLine('Test Disovery failed: ');
                    this.outputChannel.appendLine('' + reason);
                }
                storeDiscoveredTests(null);
                this.disposeCancellationToken();
                return Promise.reject(reason);
            });
    }
    abstract discoverTestsImpl(): Promise<Tests>;
    public runTest(testsToRun?: TestsToRun): Promise<Tests>;
    public runTest(runFailedTests?: boolean): Promise<Tests>;
    public runTest(args: any): Promise<Tests> {
        let runFailedTests = false;
        let testsToRun: TestsToRun = null;
        if (typeof args === 'boolean') {
            runFailedTests = args === true;
        }
        if (typeof args === 'object' && args !== null) {
            testsToRun = args;
        }
        this.resetTestResults();
        this._status = TestStatus.Running;
        this.createCancellationToken();
        return this.discoverTests()
            .catch(reason => {
                displayTestErrorMessage('Errors in discovering Unit Tests, continuing with tests');
                return <Tests>{
                    rootTestFolders: [], testFiles: [], testFolders: [], testFunctions: [], testSuits: [],
                    summary: { errors: 0, failures: 0, passed: 0, skipped: 0 }
                };
            })
            .then(tests => {
                return this.runTestImpl(tests, testsToRun, runFailedTests);
            }).then(() => {
                this._status = TestStatus.Idle;
                this.disposeCancellationToken();
                return this.tests;
            }).catch(reason => {
                if (this.cancellationToken.isCancellationRequested) {
                    reason = CANCELLATION_REASON;
                    this._status = TestStatus.Idle;
                }
                else {
                    this._status = TestStatus.Error;
                }
                this.disposeCancellationToken();
                return Promise.reject(reason);
            });
    }
    abstract runTestImpl(tests: Tests, testsToRun?: TestsToRun, runFailedTests?: boolean): Promise<any>;
    // abstract stopImpl(): Promise<any>;
}
export function resolveValueAsTestToRun(name: string): TestsToRun {
    // TODO: We need a better way to match (currently we have raw name, name, xmlname, etc = which one do we
    // use to identify a file given the full file name, similary for a folder and function
    // Perhaps something like a parser or methods like TestFunction.fromString()... something)
    let tests = getDiscoveredTests();
    if (!tests) { return null; }

    let testFolders = tests.testFolders.filter(folder => folder.nameToRun === name || folder.name === name);
    if (testFolders.length > 0) { return { testFolder: testFolders }; };

    let testFiles = tests.testFiles.filter(file => file.nameToRun === name || file.name === name);
    if (testFiles.length > 0) { return { testFile: testFiles }; };

    let testFns = tests.testFunctions.filter(fn => fn.testFunction.nameToRun === name || fn.testFunction.name === name).map(fn => fn.testFunction);
    if (testFns.length > 0) { return { testFunction: testFns }; };

    // Just return this as a test file
    return <TestsToRun>{ testFile: [{ name: name, nameToRun: name, functions: [], suites: [], xmlName: name, time: 0 }] };
}
export function extractBetweenDelimiters(content: string, startDelimiter: string, endDelimiter: string): string {
    content = content.substring(content.indexOf(startDelimiter) + startDelimiter.length);
    return content.substring(0, content.lastIndexOf(endDelimiter));
}

export function convertFileToPackage(filePath: string): string {
    let lastIndex = filePath.lastIndexOf('.');
    return filePath.substring(0, lastIndex).replace(/\//g, '.').replace(/\\/g, '.');
}

export function updateResults(tests: Tests) {
    tests.testFiles.forEach(updateResultsUpstream);
    tests.testFolders.forEach(updateFolderResultsUpstream);
}

export function updateFolderResultsUpstream(testFolder: TestFolder) {
    let totalTime = 0;
    let allFilesPassed = true;
    let allFilesRan = true;

    testFolder.testFiles.forEach(fl => {
        if (allFilesPassed && typeof fl.passed === 'boolean') {
            if (!fl.passed) {
                allFilesPassed = false;
            }
        }
        else {
            allFilesRan = false;
        }

        testFolder.functionsFailed += fl.functionsFailed;
        testFolder.functionsPassed += fl.functionsPassed;
    });

    let allFoldersPassed = true;
    let allFoldersRan = true;

    testFolder.folders.forEach(folder => {
        updateFolderResultsUpstream(folder);
        if (allFoldersPassed && typeof folder.passed === 'boolean') {
            if (!folder.passed) {
                allFoldersPassed = false;
            }
        }
        else {
            allFoldersRan = false;
        }

        testFolder.functionsFailed += folder.functionsFailed;
        testFolder.functionsPassed += folder.functionsPassed;
    });

    if (allFilesRan && allFoldersRan) {
        testFolder.passed = allFilesPassed && allFoldersPassed;
        testFolder.status = testFolder.passed ? TestStatus.Idle : TestStatus.Fail;
    }
    else {
        testFolder.passed = null;
        testFolder.status = TestStatus.Unknown;
    }
}

export function updateResultsUpstream(test: TestSuite | TestFile) {
    let totalTime = 0;
    let allFunctionsPassed = true;
    let allFunctionsRan = true;

    test.functions.forEach(fn => {
        totalTime += fn.time;
        if (typeof fn.passed === 'boolean') {
            if (fn.passed) {
                test.functionsPassed += 1;
            }
            else {
                test.functionsFailed += 1;
                allFunctionsPassed = false;
            }
        }
        else {
            allFunctionsRan = false;
        }
    });

    let allSuitesPassed = true;
    let allSuitesRan = true;

    test.suites.forEach(suite => {
        updateResultsUpstream(suite);
        totalTime += suite.time;
        if (allSuitesRan && typeof suite.passed === 'boolean') {
            if (!suite.passed) {
                allSuitesPassed = false;
            }
        }
        else {
            allSuitesRan = false;
        }

        test.functionsFailed += suite.functionsFailed;
        test.functionsPassed += suite.functionsPassed;
    });

    test.time = totalTime;
    if (allSuitesRan && allFunctionsRan) {
        test.passed = allFunctionsPassed && allSuitesPassed;
        test.status = test.passed ? TestStatus.Idle : TestStatus.Error;
    }
    else {
        test.passed = null;
        test.status = TestStatus.Unknown;
    }
}

export function placeTestFilesInFolders(tests: Tests) {
    // First get all the unique folders
    const folders: string[] = [];
    tests.testFiles.forEach(file => {
        let dir = path.dirname(file.name);
        if (folders.indexOf(dir) === -1) {
            folders.push(dir);
        }
    });

    tests.testFolders = [];
    const folderMap = new Map<string, TestFolder>();
    folders.sort();

    folders.forEach(dir => {
        dir.split(path.sep).reduce((parentPath, currentName, index, values) => {
            let newPath = currentName;
            let parentFolder: TestFolder;
            if (parentPath.length > 0) {
                parentFolder = folderMap.get(parentPath);
                newPath = path.join(parentPath, currentName);
            }
            if (!folderMap.has(newPath)) {
                const testFolder: TestFolder = { name: newPath, testFiles: [], folders: [], nameToRun: newPath, time: 0 };
                folderMap.set(newPath, testFolder);
                if (parentFolder) {
                    parentFolder.folders.push(testFolder);
                }
                else {
                    tests.rootTestFolders.push(testFolder);
                }
                tests.testFiles.filter(fl => path.dirname(fl.name) === newPath).forEach(testFile => {
                    testFolder.testFiles.push(testFile);
                });
                tests.testFolders.push(testFolder);
            }
            return newPath;
        }, '');
    });
}
export function flattenTestFiles(testFiles: TestFile[]): Tests {
    let fns: FlattenedTestFunction[] = [];
    let suites: FlattenedTestSuite[] = [];
    testFiles.forEach(testFile => {
        // sample test_three (file name without extension and all / replaced with ., meaning this is the package)
        const packageName = convertFileToPackage(testFile.name);

        testFile.functions.forEach(fn => {
            fns.push({ testFunction: fn, xmlClassName: packageName, parentTestFile: testFile });
        });

        testFile.suites.forEach(suite => {
            suites.push({ parentTestFile: testFile, testSuite: suite, xmlClassName: suite.xmlName });
            flattenTestSuites(fns, suites, testFile, suite);
        });
    });

    let tests = <Tests>{
        testFiles: testFiles,
        testFunctions: fns, testSuits: suites,
        testFolders: [],
        rootTestFolders: [],
        summary: { passed: 0, failures: 0, errors: 0, skipped: 0 }
    };

    placeTestFilesInFolders(tests);

    return tests;
}
export function flattenTestSuites(flattenedFns: FlattenedTestFunction[], flattenedSuites: FlattenedTestSuite[], testFile: TestFile, testSuite: TestSuite) {
    testSuite.functions.forEach(fn => {
        flattenedFns.push({ testFunction: fn, xmlClassName: testSuite.xmlName, parentTestFile: testFile, parentTestSuite: testSuite });
    });

    // We may have child classes
    testSuite.suites.forEach(suite => {
        flattenedSuites.push({ parentTestFile: testFile, testSuite: suite, xmlClassName: suite.xmlName });
        flattenTestSuites(flattenedFns, flattenedSuites, testFile, suite);
    });
}

function resetTestResults(tests: Tests) {
    tests.testFolders.forEach(f => {
        f.functionsDidNotRun = 0;
        f.functionsFailed = 0;
        f.functionsPassed = 0;
        f.passed = null;
        f.status = TestStatus.Unknown;
    });
    tests.testFunctions.forEach(fn => {
        fn.testFunction.passed = null;
        fn.testFunction.time = 0;
        fn.testFunction.message = '';
        fn.testFunction.traceback = '';
        fn.testFunction.status = TestStatus.Unknown;
        fn.testFunction.functionsFailed = 0;
        fn.testFunction.functionsPassed = 0;
        fn.testFunction.functionsDidNotRun = 0;
    });
    tests.testSuits.forEach(suite => {
        suite.testSuite.passed = null;
        suite.testSuite.time = 0;
        suite.testSuite.status = TestStatus.Unknown;
        suite.testSuite.functionsFailed = 0;
        suite.testSuite.functionsPassed = 0;
        suite.testSuite.functionsDidNotRun = 0;
    });
    tests.testFiles.forEach(testFile => {
        testFile.passed = null;
        testFile.time = 0;
        testFile.status = TestStatus.Unknown;
        testFile.functionsFailed = 0;
        testFile.functionsPassed = 0;
        testFile.functionsDidNotRun = 0;
    });
}