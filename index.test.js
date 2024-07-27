const run = require('.');
const core = require('@actions/core');
const { CodeDeploy, waitUntilDeploymentSuccessful } = require('@aws-sdk/client-codedeploy');
const { ECS, waitUntilServicesStable } = require('@aws-sdk/client-ecs');
const fs = require('fs');
const path = require('path');

jest.mock('@actions/core');
jest.mock('fs', () => ({
    promises: { access: jest.fn() },
    readFileSync: jest.fn(),
}));

const mockEcsRegisterTaskDef = jest.fn();
const mockEcsUpdateService = jest.fn();
const mockEcsDescribeServices = jest.fn();
const mockCodeDeployCreateDeployment = jest.fn();
const mockCodeDeployGetDeploymentGroup = jest.fn();
const config = {
    region: () => Promise.resolve('fake-region'),
};

jest.mock('@aws-sdk/client-codedeploy');
jest.mock('@aws-sdk/client-ecs');

const EXPECTED_DEFAULT_WAIT_TIME = 30;
const EXPECTED_CODE_DEPLOY_DEPLOYMENT_READY_WAIT_TIME = 60;
const EXPECTED_CODE_DEPLOY_TERMINATION_WAIT_TIME = 30;

describe('Deploy to ECS', () => {

    const mockEcsClient = {
        config,
        registerTaskDefinition: mockEcsRegisterTaskDef,
        updateService: mockEcsUpdateService,
        describeServices: mockEcsDescribeServices
    };

    const mockCodeDeployClient = {
        config,
        createDeployment: mockCodeDeployCreateDeployment,
        getDeploymentGroup: mockCodeDeployGetDeploymentGroup
    };

    beforeEach(() => {
        jest.clearAllMocks();

        core.getInput = jest
            .fn()
            .mockReturnValueOnce('task-definition.json') // task-definition
            .mockReturnValueOnce('service-456')         // service
            .mockReturnValueOnce('cluster-789');        // cluster

        process.env = Object.assign(process.env, { GITHUB_WORKSPACE: __dirname });

        fs.readFileSync.mockImplementation((pathInput, encoding) => {
            if (encoding != 'utf8') {
                throw new Error(`Wrong encoding ${encoding}`);
            }

            if (pathInput == path.join(process.env.GITHUB_WORKSPACE, 'appspec.yaml')) {
                return `
                Resources:
                - TargetService:
                    Type: AWS::ECS::Service
                    Properties:
                      TaskDefinition: helloworld
                      LoadBalancerInfo:
                        ContainerName: web
                        ContainerPort: 80`;
            }

            if (pathInput == path.join(process.env.GITHUB_WORKSPACE, 'task-definition.json')) {
                return JSON.stringify({ family: 'task-def-family' });
            }

            throw new Error(`Unknown path ${pathInput}`);
        });

        mockEcsRegisterTaskDef.mockImplementation(
            () => Promise.resolve({ taskDefinition: { taskDefinitionArn: 'task:def:arn' } })
        );

        mockEcsUpdateService.mockImplementation(() => Promise.resolve({}));

        mockEcsDescribeServices.mockImplementation(
            () => Promise.resolve({
                failures: [],
                services: [{ status: 'ACTIVE' }]
            })
        );

        mockCodeDeployCreateDeployment.mockImplementation(
            () => Promise.resolve({ deploymentId: 'deployment-1' })
        );

        mockCodeDeployGetDeploymentGroup.mockImplementation(
            () => Promise.resolve({
                deploymentGroupInfo: {
                    blueGreenDeploymentConfiguration: {
                        deploymentReadyOption: {
                            waitTimeInMinutes: EXPECTED_CODE_DEPLOY_DEPLOYMENT_READY_WAIT_TIME
                        },
                        terminateBlueInstancesOnDeploymentSuccess: {
                            terminationWaitTimeInMinutes: EXPECTED_CODE_DEPLOY_TERMINATION_WAIT_TIME
                        }
                    }
                }
            })
        );

        ECS.mockImplementation(() => mockEcsClient);

        waitUntilServicesStable.mockImplementation(() => Promise.resolve({}));

        CodeDeploy.mockImplementation(() => mockCodeDeployClient);

        waitUntilDeploymentSuccessful.mockImplementation(() => Promise.resolve({}));
    });

    test('registers the task definition contents and updates the service', async () => {
        await run();
        expect(core.setFailed).toHaveBeenCalledTimes(0);
        expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, { family: 'task-def-family' });
        expect(core.setOutput).toHaveBeenNthCalledWith(1, 'task-definition-arn', 'task:def:arn');
        expect(mockEcsDescribeServices).toHaveBeenNthCalledWith(1, {
            cluster: 'cluster-789',
            services: ['service-456']
        });
        expect(mockEcsUpdateService).toHaveBeenNthCalledWith(1, {
            cluster: 'cluster-789',
            service: 'service-456',
            taskDefinition: 'task:def:arn',
            forceNewDeployment: false
        });
        expect(waitUntilServicesStable).toHaveBeenCalledTimes(0);
        expect(core.info).toBeCalledWith("Deployment started. Watch this deployment's progress in the Amazon ECS console: https://fake-region.console.aws.amazon.com/ecs/v2/clusters/cluster-789/services/service-456/events?region=fake-region");
    });

    test('registers the task definition contents and updates the service if deployment controller type is ECS', async () => {
        mockEcsDescribeServices.mockImplementation(
            () => Promise.resolve({
                failures: [],
                services: [{
                    status: 'ACTIVE',
                    deploymentController: {
                        type: 'ECS'
                    }
                }]
            })
        );

        await run();
        expect(core.setFailed).toHaveBeenCalledTimes(0);
        expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, { family: 'task-def-family' });
        expect(core.setOutput).toHaveBeenNthCalledWith(1, 'task-definition-arn', 'task:def:arn');
        expect(mockEcsDescribeServices).toHaveBeenNthCalledWith(1, {
            cluster: 'cluster-789',
            services: ['service-456']
        });
        expect(mockEcsUpdateService).toHaveBeenNthCalledWith(1, {
            cluster: 'cluster-789',
            service: 'service-456',
            taskDefinition: 'task:def:arn',
            forceNewDeployment: false
        });
        expect(waitUntilServicesStable).toHaveBeenCalledTimes(0);
        expect(core.info).toBeCalledWith("Deployment started. Watch this deployment's progress in the Amazon ECS console: https://fake-region.console.aws.amazon.com/ecs/v2/clusters/cluster-789/services/service-456/events?region=fake-region");
    });

    test('prints Chinese console domain for cn regions', async () => {
        const originalRegion = config.region;
        config.region = () => Promise.resolve('cn-fake-region');
        await run();

        expect(core.info).toBeCalledWith("Deployment started. Watch this deployment's progress in the Amazon ECS console: https://cn-fake-region.console.amazonaws.cn/ecs/v2/clusters/cluster-789/services/service-456/events?region=cn-fake-region");

        // reset
        config.region = originalRegion;
    });

    test('cleans null keys out of the task definition contents', async () => {
        fs.readFileSync.mockImplementation((pathInput, encoding) => {
            if (encoding != 'utf8') {
                throw new Error(`Wrong encoding ${encoding}`);
            }

            return '{ "ipcMode": null, "family": "task-def-family" }';
        });

        await run();
        expect(core.setFailed).toHaveBeenCalledTimes(0);
        expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, { family: 'task-def-family' });
    });

    test('cleans empty arrays out of the task definition contents', async () => {
        fs.readFileSync.mockImplementation((pathInput, encoding) => {
            if (encoding != 'utf8') {
                throw new Error(`Wrong encoding ${encoding}`);
            }

            return '{ "tags": [], "family": "task-def-family" }';
        });

        await run();
        expect(core.setFailed).toHaveBeenCalledTimes(0);
        expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, { family: 'task-def-family' });
    });

    test('cleans empty strings and objects out of the task definition contents', async () => {
        fs.readFileSync.mockImplementation((pathInput, encoding) => {
            if (encoding != 'utf8') {
                throw new Error(`Wrong encoding ${encoding}`);
            }

            return `
            {
                "memory": "",
                "containerDefinitions": [ {
                    "name": "sample-container",
                    "logConfiguration": {},
                    "repositoryCredentials": { "credentialsParameter": "" },
                    "command": [
                        ""
                    ],
                    "environment": [
                        {
                            "name": "hello",
                            "value": "world"
                        },
                        {
                            "name": "test",
                            "value": ""
                        },
                        {
                            "name": "",
                            "value": ""
                        }
                    ],
                    "secretOptions": [ {
                        "name": "",
                        "valueFrom": ""
                    } ],
                    "cpu": 0,
                    "essential": false
                } ],
                "requiresCompatibilities": [ "EC2" ],
                "registeredAt": 1611690781,
                "family": "task-def-family"
            }
            `;
        });

        await run();
        expect(core.setFailed).toHaveBeenCalledTimes(0);
        expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, {
            family: 'task-def-family',
            containerDefinitions: [
                {
                    name: 'sample-container',
                    cpu: 0,
                    essential: false,
                    environment: [{
                        name: 'hello',
                        value: 'world'
                    }, {
                        "name": "test",
                        "value": ""
                    }]
                }
            ],
            requiresCompatibilities: ['EC2']
        });
    });

    test('maintains empty keys in proxyConfiguration.properties for APPMESH', async () => {
        fs.readFileSync.mockImplementation((pathInput, encoding) => {
            if (encoding != 'utf8') {
                throw new Error(`Wrong encoding ${encoding}`);
            }

            return `
            {
                "memory": "",
                "containerDefinitions": [ {
                    "name": "sample-container",
                    "logConfiguration": {},
                    "repositoryCredentials": { "credentialsParameter": "" },
                    "command": [
                        ""
                    ],
                    "environment": [
                        {
                            "name": "hello",
                            "value": "world"
                        },
                        {
                            "name": "",
                            "value": ""
                        }
                    ],
                    "secretOptions": [ {
                        "name": "",
                        "valueFrom": ""
                    } ],
                    "cpu": 0,
                    "essential": false
                } ],
                "requiresCompatibilities": [ "EC2" ],
                "registeredAt": 1611690781,
                "family": "task-def-family",
                "proxyConfiguration": {
                    "type": "APPMESH",
                    "containerName": "envoy",
                    "properties": [
                        {
                            "name": "ProxyIngressPort",
                            "value": "15000"
                        },
                        {
                            "name": "AppPorts",
                            "value": "1234"
                        },
                        {
                            "name": "EgressIgnoredIPs",
                            "value": "169.254.170.2,169.254.169.254"
                        },
                        {
                            "name": "IgnoredGID",
                            "value": ""
                        },
                        {
                            "name": "EgressIgnoredPorts",
                            "value": ""
                        },
                        {
                            "name": "IgnoredUID",
                            "value": "1337"
                        },
                        {
                            "name": "ProxyEgressPort",
                            "value": "15001"
                        },
                        {
                            "value": "some-value"
                        }
                    ]
                }
            }
            `;
        });

        await run();
        expect(core.setFailed).toHaveBeenCalledTimes(0);
        expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, {
            family: 'task-def-family',
            containerDefinitions: [
                {
                    name: 'sample-container',
                    cpu: 0,
                    essential: false,
                    environment: [{
                        name: 'hello',
                        value: 'world'
                    }]
                }
            ],
            requiresCompatibilities: ['EC2'],
            proxyConfiguration: {
                type: "APPMESH",
                containerName: "envoy",
                properties: [
                    {
                        name: "ProxyIngressPort",
                        value: "15000"
                    },
                    {
                        name: "AppPorts",
                        value: "1234"
                    },
                    {
                        name: "EgressIgnoredIPs",
                        value: "169.254.170.2,169.254.169.254"
                    },
                    {
                        name: "IgnoredGID",
                        value: ""
                    },
                    {
                        name: "EgressIgnoredPorts",
                        value: ""
                    },
                    {
                        name: "IgnoredUID",
                        value: "1337"
                    },
                    {
                        name: "ProxyEgressPort",
                        value: "15001"
                    },
                    {
                        name: "",
                        value: "some-value"
                    }
                ]
            }
        });
    });

    test('cleans invalid keys out of the task definition contents', async () => {
        fs.readFileSync.mockImplementation((pathInput, encoding) => {
            if (encoding != 'utf8') {
                throw new Error(`Wrong encoding ${encoding}`);
            }

            return '{ "compatibilities": ["EC2"], "taskDefinitionArn": "arn:aws...:task-def-family:1", "family": "task-def-family", "revision": 1, "status": "ACTIVE" }';
        });

        await run();
        expect(core.setFailed).toHaveBeenCalledTimes(0);
        expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, { family: 'task-def-family' });
    });

    test('registers the task definition contents and creates a CodeDeploy deployment, waits for 30 minutes + deployment group wait time', async () => {
        core.getInput = jest
            .fn()
            .mockReturnValueOnce('task-definition.json') // task-definition
            .mockReturnValueOnce('service-456')         // service
            .mockReturnValueOnce('cluster-789')         // cluster
            .mockReturnValueOnce('TRUE');               // wait-for-service-stability

        mockEcsDescribeServices.mockImplementation(
            () => Promise.resolve({
                failures: [],
                services: [{
                    status: 'ACTIVE',
                    deploymentController: {
                        type: 'CODE_DEPLOY'
                    }
                }]
            })
        );

        await run();
        expect(core.setFailed).toHaveBeenCalledTimes(0);

        expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, { family: 'task-def-family' });
        expect(core.setOutput).toHaveBeenNthCalledWith(1, 'task-definition-arn', 'task:def:arn');
        expect(mockEcsDescribeServices).toHaveBeenNthCalledWith(1, {
            cluster: 'cluster-789',
            services: ['service-456']
        });

        expect(mockCodeDeployCreateDeployment).toHaveBeenNthCalledWith(1, {
            applicationName: 'AppECS-cluster-789-service-456',
            deploymentGroupName: 'DgpECS-cluster-789-service-456',
            revision: {
                revisionType: 'AppSpecContent',
                appSpecContent: {
                    content: JSON.stringify({
                        Resources: [{
                            TargetService: {
                                Type: 'AWS::ECS::Service',
                                Properties: {
                                    TaskDefinition: 'task:def:arn',
                                    LoadBalancerInfo: {
                                        ContainerName: "web",
                                        ContainerPort: 80
                                    }
                                }
                            }
                        }]
                    }),
                    sha256: '0911d1e99f48b492e238d1284d8ddb805382d33e1d1fc74ffadf37d8b7e6d096'
                }
            }
        });

        expect(waitUntilDeploymentSuccessful).toHaveBeenNthCalledWith(
            1,
            {
                client: mockCodeDeployClient,
                minDelay: 15,
                maxWaitTime: (
                    EXPECTED_DEFAULT_WAIT_TIME +
                    EXPECTED_CODE_DEPLOY_TERMINATION_WAIT_TIME +
                    EXPECTED_CODE_DEPLOY_DEPLOYMENT_READY_WAIT_TIME
                ) * 60,
            },
            {
                deploymentId: 'deployment-1',
            }
        );

        expect(mockEcsUpdateService).toHaveBeenCalledTimes(0);
        expect(waitUntilServicesStable).toHaveBeenCalledTimes(0);

        expect(core.info).toBeCalledWith("Deployment started. Watch this deployment's progress in the AWS CodeDeploy console: https://console.aws.amazon.com/codesuite/codedeploy/deployments/deployment-1?region=cn-fake-region");
    });

    test('registers the task definition contents and creates a CodeDeploy deployment, waits for 1 hour + deployment group\'s wait time', async () => {
        core.getInput = jest
            .fn()
            .mockReturnValueOnce('task-definition.json') // task-definition
            .mockReturnValueOnce('service-456')         // service
            .mockReturnValueOnce('cluster-789')         // cluster
            .mockReturnValueOnce('TRUE')                // wait-for-service-stability
            .mockReturnValueOnce('60');                 // wait-for-minutes

        mockEcsDescribeServices.mockImplementation(
            () => Promise.resolve({
                failures: [],
                services: [{
                    status: 'ACTIVE',
                    deploymentController: {
                        type: 'CODE_DEPLOY'
                    }
                }]
            })
        );

        await run();
        expect(core.setFailed).toHaveBeenCalledTimes(0);

        expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, { family: 'task-def-family' });
        expect(core.setOutput).toHaveBeenNthCalledWith(1, 'task-definition-arn', 'task:def:arn');
        expect(mockEcsDescribeServices).toHaveBeenNthCalledWith(1, {
            cluster: 'cluster-789',
            services: ['service-456']
        });

        expect(mockCodeDeployCreateDeployment).toHaveBeenNthCalledWith(1, {
            applicationName: 'AppECS-cluster-789-service-456',
            deploymentGroupName: 'DgpECS-cluster-789-service-456',
            revision: {
                revisionType: 'AppSpecContent',
                appSpecContent: {
                    content: JSON.stringify({
                        Resources: [{
                            TargetService: {
                                Type: 'AWS::ECS::Service',
                                Properties: {
                                    TaskDefinition: 'task:def:arn',
                                    LoadBalancerInfo: {
                                        ContainerName: "web",
                                        ContainerPort: 80
                                    }
                                }
                            }
                        }]
                    }),
                    sha256: '0911d1e99f48b492e238d1284d8ddb805382d33e1d1fc74ffadf37d8b7e6d096'
                }
            }
        });

        expect(waitUntilDeploymentSuccessful).toHaveBeenNthCalledWith(
            1,
            {
                client: mockCodeDeployClient,
                minDelay: 15,
                maxWaitTime: (
                    60 +
                    EXPECTED_CODE_DEPLOY_TERMINATION_WAIT_TIME +
                    EXPECTED_CODE_DEPLOY_DEPLOYMENT_READY_WAIT_TIME
                ) * 60,
            },
            {
                deploymentId: 'deployment-1',
            }
        );

        expect(mockEcsUpdateService).toHaveBeenCalledTimes(0);
        expect(waitUntilServicesStable).toHaveBeenCalledTimes(0);
    });

    test('registers the task definition contents and creates a CodeDeploy deployment, waits for max 6 hours', async () => {
        core.getInput = jest
            .fn()
            .mockReturnValueOnce('task-definition.json') // task-definition
            .mockReturnValueOnce('service-456')         // service
            .mockReturnValueOnce('cluster-789')         // cluster
            .mockReturnValueOnce('TRUE')                // wait-for-service-stability
            .mockReturnValueOnce('1000');               // wait-for-minutes

        mockEcsDescribeServices.mockImplementation(
            () => Promise.resolve({
                failures: [],
                services: [{
                    status: 'ACTIVE',
                    deploymentController: {
                        type: 'CODE_DEPLOY'
                    }
                }]
            })
        );

        await run();
        expect(core.setFailed).toHaveBeenCalledTimes(0);

        expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, { family: 'task-def-family' });
        expect(core.setOutput).toHaveBeenNthCalledWith(1, 'task-definition-arn', 'task:def:arn');
        expect(mockEcsDescribeServices).toHaveBeenNthCalledWith(1, {
            cluster: 'cluster-789',
            services: ['service-456']
        });

        expect(mockCodeDeployCreateDeployment).toHaveBeenNthCalledWith(1, {
            applicationName: 'AppECS-cluster-789-service-456',
            deploymentGroupName: 'DgpECS-cluster-789-service-456',
            revision: {
                revisionType: 'AppSpecContent',
                appSpecContent: {
                    content: JSON.stringify({
                        Resources: [{
                            TargetService: {
                                Type: 'AWS::ECS::Service',
                                Properties: {
                                    TaskDefinition: 'task:def:arn',
                                    LoadBalancerInfo: {
                                        ContainerName: "web",
                                        ContainerPort: 80
                                    }
                                }
                            }
                        }]
                    }),
                    sha256: '0911d1e99f48b492e238d1284d8ddb805382d33e1d1fc74ffadf37d8b7e6d096'
                }
            }
        });

        expect(waitUntilDeploymentSuccessful).toHaveBeenNthCalledWith(
            1,
            {
                client: mockCodeDeployClient,
                minDelay: 15,
                maxWaitTime: 6 * 60 * 60,
            },
            {
                deploymentId: 'deployment-1',
            }
        );

        expect(mockEcsUpdateService).toHaveBeenCalledTimes(0);
        expect(waitUntilServicesStable).toHaveBeenCalledTimes(0);
    });

    test('does not wait for a CodeDeploy deployment, parses JSON appspec file', async () => {
        core.getInput = jest
            .fn()
            .mockReturnValueOnce('task-definition.json') // task-definition
            .mockReturnValueOnce('service-456')          // service
            .mockReturnValueOnce('cluster-789')          // cluster
            .mockReturnValueOnce('false')                // wait-for-service-stability
            .mockReturnValueOnce('')                     // wait-for-minutes
            .mockReturnValueOnce('')                     // force-new-deployment
            .mockReturnValueOnce('')                     // desired count
            .mockReturnValueOnce('/hello/appspec.json')  // codedeploy-appspec
            .mockReturnValueOnce('MyApplication')        // codedeploy-application
            .mockReturnValueOnce('MyDeploymentGroup')    // codedeploy-deployment-group

        fs.readFileSync.mockReturnValue(`
            {
                "Resources": [
                    {
                        "TargetService": {
                            "Type": "AWS::ECS::Service",
                            "Properties": {
                                "TaskDefinition": "helloworld",
                                "LoadBalancerInfo": {
                                    "ContainerName": "web",
                                    "ContainerPort": 80
                                }
                            }
                        }
                    }
                ]
            }
        `);

        fs.readFileSync.mockImplementation((pathInput, encoding) => {
            if (encoding != 'utf8') {
                throw new Error(`Wrong encoding ${encoding}`);
            }

            if (pathInput == path.join('/hello/appspec.json')) {
                return `
                {
                    "Resources": [
                        {
                            "TargetService": {
                                "Type": "AWS::ECS::Service",
                                "Properties": {
                                    "TaskDefinition": "helloworld",
                                    "LoadBalancerInfo": {
                                        "ContainerName": "web",
                                        "ContainerPort": 80
                                    }
                                }
                            }
                        }
                    ]
                }`;
            }

            if (pathInput == path.join(process.env.GITHUB_WORKSPACE, 'task-definition.json')) {
                return JSON.stringify({ family: 'task-def-family' });
            }

            throw new Error(`Unknown path ${pathInput}`);
        });

        mockEcsDescribeServices.mockImplementation(
            () => Promise.resolve({
                failures: [],
                services: [{
                    status: 'ACTIVE',
                    deploymentController: {
                        type: 'CODE_DEPLOY'
                    }
                }]
            })
        );

        await run();
        expect(core.setFailed).toHaveBeenCalledTimes(0);

        expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, { family: 'task-def-family' });
        expect(core.setOutput).toHaveBeenNthCalledWith(1, 'task-definition-arn', 'task:def:arn');
        expect(mockEcsDescribeServices).toHaveBeenNthCalledWith(1, {
            cluster: 'cluster-789',
            services: ['service-456']
        });

        expect(mockCodeDeployCreateDeployment).toHaveBeenNthCalledWith(1, {
            applicationName: 'MyApplication',
            deploymentGroupName: 'MyDeploymentGroup',
            revision: {
                revisionType: 'AppSpecContent',
                appSpecContent: {
                    content: JSON.stringify({
                        Resources: [{
                            TargetService: {
                                Type: 'AWS::ECS::Service',
                                Properties: {
                                    TaskDefinition: 'task:def:arn',
                                    LoadBalancerInfo: {
                                        ContainerName: "web",
                                        ContainerPort: 80
                                    }
                                }
                            }
                        }]
                    }),
                    sha256: '0911d1e99f48b492e238d1284d8ddb805382d33e1d1fc74ffadf37d8b7e6d096'
                }
            }
        });

        expect(waitUntilDeploymentSuccessful).toHaveBeenCalledTimes(0);
        expect(mockEcsUpdateService).toHaveBeenCalledTimes(0);
        expect(waitUntilServicesStable).toHaveBeenCalledTimes(0);
    });

    test('registers the task definition contents and creates a CodeDeploy deployment with custom application, deployment group, description and config', async () => {
        core.getInput = jest
            .fn(input => {
                return {
                    'task-definition': 'task-definition.json',
                    'service': 'service-456',
                    'cluster': 'cluster-789',
                    'wait-for-service-stability': 'TRUE',
                    'codedeploy-application': 'Custom-Application',
                    'codedeploy-deployment-group': 'Custom-Deployment-Group',
                    'codedeploy-deployment-description': 'Custom-Deployment',
                    'codedeploy-deployment-config': 'CodeDeployDefault.AllAtOnce'
                }[input];
            });

        mockEcsDescribeServices.mockImplementation(
            () => Promise.resolve({
                failures: [],
                services: [{
                    status: 'ACTIVE',
                    deploymentController: {
                        type: 'CODE_DEPLOY'
                    }
                }]
            })
        );

        await run();
        expect(core.setFailed).toHaveBeenCalledTimes(0);

        expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, { family: 'task-def-family' });
        expect(core.setOutput).toHaveBeenNthCalledWith(1, 'task-definition-arn', 'task:def:arn');
        expect(mockEcsDescribeServices).toHaveBeenNthCalledWith(1, {
            cluster: 'cluster-789',
            services: ['service-456']
        });

        expect(mockCodeDeployCreateDeployment).toHaveBeenNthCalledWith(1, {
            applicationName: 'Custom-Application',
            deploymentGroupName: 'Custom-Deployment-Group',
            deploymentConfigName: 'CodeDeployDefault.AllAtOnce',
            description: 'Custom-Deployment',
            revision: {
                revisionType: 'AppSpecContent',
                appSpecContent: {
                    content: JSON.stringify({
                        Resources: [{
                            TargetService: {
                                Type: 'AWS::ECS::Service',
                                Properties: {
                                    TaskDefinition: 'task:def:arn',
                                    LoadBalancerInfo: {
                                        ContainerName: "web",
                                        ContainerPort: 80
                                    }
                                }
                            }
                        }]
                    }),
                    sha256: '0911d1e99f48b492e238d1284d8ddb805382d33e1d1fc74ffadf37d8b7e6d096'
                }
            }
        });

        expect(waitUntilDeploymentSuccessful).toHaveBeenNthCalledWith(
            1,
            {
                client: mockCodeDeployClient,
                minDelay: 15,
                maxWaitTime: (
                    EXPECTED_DEFAULT_WAIT_TIME +
                    EXPECTED_CODE_DEPLOY_TERMINATION_WAIT_TIME +
                    EXPECTED_CODE_DEPLOY_DEPLOYMENT_READY_WAIT_TIME
                ) * 60,
            },
            {
                deploymentId: 'deployment-1',
            }
        );

        expect(mockEcsUpdateService).toHaveBeenCalledTimes(0);
        expect(waitUntilServicesStable).toHaveBeenCalledTimes(0);

        expect(core.info).toBeCalledWith("Deployment started. Watch this deployment's progress in the AWS CodeDeploy console: https://console.aws.amazon.com/codesuite/codedeploy/deployments/deployment-1?region=cn-fake-region");
    });

    test('registers the task definition contents at an absolute path', async () => {
        core.getInput = jest.fn().mockReturnValueOnce('/hello/task-definition.json');
        fs.readFileSync.mockImplementation((pathInput, encoding) => {
            if (encoding != 'utf8') {
                throw new Error(`Wrong encoding ${encoding}`);
            }

            if (pathInput == '/hello/task-definition.json') {
                return JSON.stringify({ family: 'task-def-family-absolute-path' });
            }

            throw new Error(`Unknown path ${pathInput}`);
        });

        await run();
        expect(core.setFailed).toHaveBeenCalledTimes(0);

        expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, { family: 'task-def-family-absolute-path' });
        expect(core.setOutput).toHaveBeenNthCalledWith(1, 'task-definition-arn', 'task:def:arn');
    });

    test('waits for the service to be stable', async () => {
        core.getInput = jest
            .fn()
            .mockReturnValueOnce('task-definition.json') // task-definition
            .mockReturnValueOnce('service-456')          // service
            .mockReturnValueOnce('cluster-789')          // cluster
            .mockReturnValueOnce('TRUE')                 // wait-for-service-stability
            .mockReturnValueOnce('');                    // desired count

        await run();
        expect(core.setFailed).toHaveBeenCalledTimes(0);

        expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, { family: 'task-def-family' });
        expect(core.setOutput).toHaveBeenNthCalledWith(1, 'task-definition-arn', 'task:def:arn');
        expect(mockEcsDescribeServices).toHaveBeenNthCalledWith(1, {
            cluster: 'cluster-789',
            services: ['service-456']
        });
        expect(mockEcsUpdateService).toHaveBeenNthCalledWith(1, {
            cluster: 'cluster-789',
            service: 'service-456',
            taskDefinition: 'task:def:arn',
            forceNewDeployment: false
        });
        expect(waitUntilServicesStable).toHaveBeenNthCalledWith(
            1,
            {
                client: mockEcsClient,
                minDelay: 15,
                maxWaitTime: EXPECTED_DEFAULT_WAIT_TIME * 60,
            },
            {
                services: ['service-456'],
                cluster: 'cluster-789',
            }
        );
    });

    test('waits for the service to be stable for specified minutes', async () => {
        core.getInput = jest
            .fn()
            .mockReturnValueOnce('task-definition.json') // task-definition
            .mockReturnValueOnce('service-456')          // service
            .mockReturnValueOnce('cluster-789')          // cluster
            .mockReturnValueOnce('TRUE')                 // wait-for-service-stability
            .mockReturnValueOnce('60')                   // wait-for-minutes
            .mockReturnValueOnce('');                    // desired count

        await run();
        expect(core.setFailed).toHaveBeenCalledTimes(0);

        expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, { family: 'task-def-family' });
        expect(core.setOutput).toHaveBeenNthCalledWith(1, 'task-definition-arn', 'task:def:arn');
        expect(mockEcsDescribeServices).toHaveBeenNthCalledWith(1, {
            cluster: 'cluster-789',
            services: ['service-456']
        });
        expect(mockEcsUpdateService).toHaveBeenNthCalledWith(1, {
            cluster: 'cluster-789',
            service: 'service-456',
            taskDefinition: 'task:def:arn',
            forceNewDeployment: false
        });
        expect(waitUntilServicesStable).toHaveBeenNthCalledWith(
            1,
            {
                client: mockEcsClient,
                minDelay: 15,
                maxWaitTime: 60 * 60,
            },
            {
                services: ['service-456'],
                cluster: 'cluster-789',
            }
        );
    });

    test('waits for the service to be stable for max 6 hours', async () => {
        core.getInput = jest
            .fn()
            .mockReturnValueOnce('task-definition.json') // task-definition
            .mockReturnValueOnce('service-456')          // service
            .mockReturnValueOnce('cluster-789')          // cluster
            .mockReturnValueOnce('TRUE')                 // wait-for-service-stability
            .mockReturnValueOnce('1000')                 // wait-for-minutes
            .mockReturnValueOnce('abc');                 // desired count is NaN

        await run();
        expect(core.setFailed).toHaveBeenCalledTimes(0);

        expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, { family: 'task-def-family' });
        expect(core.setOutput).toHaveBeenNthCalledWith(1, 'task-definition-arn', 'task:def:arn');
        expect(mockEcsDescribeServices).toHaveBeenNthCalledWith(1, {
            cluster: 'cluster-789',
            services: ['service-456']
        });
        expect(mockEcsUpdateService).toHaveBeenNthCalledWith(1, {
            cluster: 'cluster-789',
            service: 'service-456',
            taskDefinition: 'task:def:arn',
            forceNewDeployment: false
        });
        expect(waitUntilServicesStable).toHaveBeenNthCalledWith(
            1,
            {
                client: mockEcsClient,
                minDelay: 15,
                maxWaitTime: 6 * 60 * 60,
            },
            {
                services: ['service-456'],
                cluster: 'cluster-789',
            }
        );
    });

    test('force new deployment', async () => {
        core.getInput = jest
            .fn()
            .mockReturnValueOnce('task-definition.json') // task-definition
            .mockReturnValueOnce('service-456')          // service
            .mockReturnValueOnce('cluster-789')          // cluster
            .mockReturnValueOnce('false')                // wait-for-service-stability
            .mockReturnValueOnce('')                     // wait-for-minutes
            .mockReturnValueOnce('true')                 // force-new-deployment
            .mockReturnValueOnce('4');                   // desired count is number

        await run();
        expect(core.setFailed).toHaveBeenCalledTimes(0);

        expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, { family: 'task-def-family' });
        expect(core.setOutput).toHaveBeenNthCalledWith(1, 'task-definition-arn', 'task:def:arn');
        expect(mockEcsDescribeServices).toHaveBeenNthCalledWith(1, {
            cluster: 'cluster-789',
            services: ['service-456']
        });
        expect(mockEcsUpdateService).toHaveBeenNthCalledWith(1, {
            cluster: 'cluster-789',
            desiredCount: 4,
            service: 'service-456',
            taskDefinition: 'task:def:arn',
            forceNewDeployment: true
        });
    });

    test('defaults to the default cluster', async () => {
        core.getInput = jest
            .fn()
            .mockReturnValueOnce('task-definition.json') // task-definition
            .mockReturnValueOnce('service-456')          // service
            .mockReturnValueOnce('');                    // desired count

        await run();
        expect(core.setFailed).toHaveBeenCalledTimes(0);

        expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, { family: 'task-def-family' });
        expect(core.setOutput).toHaveBeenNthCalledWith(1, 'task-definition-arn', 'task:def:arn');
        expect(mockEcsDescribeServices).toHaveBeenNthCalledWith(1, {
            cluster: 'default',
            services: ['service-456']
        });
        expect(mockEcsUpdateService).toHaveBeenNthCalledWith(1, {
            cluster: 'default',
            service: 'service-456',
            taskDefinition: 'task:def:arn',
            forceNewDeployment: false
        });
    });

    test('does not update service if none specified', async () => {
        core.getInput = jest
            .fn()
            .mockReturnValueOnce('task-definition.json'); // task-definition

        await run();
        expect(core.setFailed).toHaveBeenCalledTimes(0);

        expect(mockEcsRegisterTaskDef).toHaveBeenNthCalledWith(1, { family: 'task-def-family' });
        expect(core.setOutput).toHaveBeenNthCalledWith(1, 'task-definition-arn', 'task:def:arn');
        expect(mockEcsDescribeServices).toHaveBeenCalledTimes(0);
        expect(mockEcsUpdateService).toHaveBeenCalledTimes(0);
    });

    test('error caught if AppSpec file is not formatted correctly', async () => {
        mockEcsDescribeServices.mockImplementation(
            () => Promise.resolve({
                failures: [],
                services: [{
                    status: 'ACTIVE',
                    deploymentController: {
                        type: 'CODE_DEPLOY'
                    }
                }]
            })
        );
        fs.readFileSync.mockReturnValue("hello: world");

        await run();

        expect(core.setFailed).toBeCalledWith("AppSpec file must include property 'resources'");
    });

    test('error is caught if service does not exist', async () => {
        mockEcsDescribeServices.mockImplementation(
            () => Promise.resolve({
                failures: [{
                    reason: 'MISSING',
                    arn: 'hello'
                }],
                services: []
            })
        );

        await run();

        expect(core.setFailed).toBeCalledWith('hello is MISSING');
    });

    test('error is caught if service is inactive', async () => {
        mockEcsDescribeServices.mockImplementation(
            () => Promise.resolve({
                failures: [],
                services: [{
                    status: 'INACTIVE'
                }]
            })
        );

        await run();

        expect(core.setFailed).toBeCalledWith('Service is INACTIVE');
    });

    test('error is caught if service uses external deployment controller', async () => {
        mockEcsDescribeServices.mockImplementation(
            () => Promise.resolve({
                failures: [],
                services: [{
                    status: 'ACTIVE',
                    deploymentController: {
                        type: 'EXTERNAL'
                    }
                }]
            })
        );

        await run();

        expect(core.setFailed).toBeCalledWith('Unsupported deployment controller: EXTERNAL');
    });

    test('error is caught if task def registration fails', async () => {
        mockEcsRegisterTaskDef.mockImplementation(() => {
            throw new Error("Could not parse");
        });

        await run();

        expect(core.setFailed).toHaveBeenCalledTimes(2);
        expect(core.setFailed).toHaveBeenNthCalledWith(1, 'Failed to register task definition in ECS: Could not parse');
        expect(core.setFailed).toHaveBeenNthCalledWith(2, 'Could not parse');
    });
});
