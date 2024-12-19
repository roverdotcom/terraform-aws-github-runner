import {
  CreateFleetCommand,
  CreateFleetResult,
  CreateTagsCommand,
  DefaultTargetCapacityType,
  DescribeInstancesCommand,
  DescribeInstancesResult,
  EC2Client,
  FleetLaunchTemplateOverridesRequest,
  Tag,
  TerminateInstancesCommand,
  StopInstancesCommand,
  StartInstancesCommand,
  _InstanceType,
  Filter,
} from '@aws-sdk/client-ec2';
import { createChildLogger } from '@aws-github-runner/aws-powertools-util';
import { getTracedAWSV3Client, tracer } from '@aws-github-runner/aws-powertools-util';
import { getParameter } from '@aws-github-runner/aws-ssm-util';
import moment from 'moment';

import ScaleError from './../scale-runners/ScaleError';
import * as Runners from './runners.d';

const logger = createChildLogger('runners');

interface Ec2Filter {
  Name: string;
  Values: string[];
}

export async function listEC2Runners(
  filters: Runners.ListRunnerFilters | undefined = undefined,
): Promise<Runners.RunnerList[]> {
  const ec2Filters = constructFilters(filters);
  const runners: Runners.RunnerList[] = [];
  for (const filter of ec2Filters) {
    runners.push(...(await getRunners(filter)));
  }
  return runners;
}

function constructFilters(filters?: Runners.ListRunnerFilters): Ec2Filter[][] {
  const ec2Statuses = filters?.statuses ? filters.statuses : ['running', 'pending'];
  const ec2Filters: Ec2Filter[][] = [];
  const ec2FiltersBase = [{ Name: 'instance-state-name', Values: ec2Statuses }];
  if (filters) {
    if (filters.environment !== undefined) {
      ec2FiltersBase.push({ Name: 'tag:ghr:environment', Values: [filters.environment] });
    }
    if (filters.runnerType && filters.runnerOwner) {
      ec2FiltersBase.push({ Name: `tag:ghr:Type`, Values: [filters.runnerType] });
      ec2FiltersBase.push({ Name: `tag:ghr:Owner`, Values: [filters.runnerOwner] });
    }
    if (filters.orphan) {
      ec2FiltersBase.push({ Name: 'tag:ghr:orphan', Values: ['true'] });
    }
  }

  for (const key of ['tag:ghr:Application']) {
    const filter = [...ec2FiltersBase];
    filter.push({ Name: key, Values: ['github-action-runner'] });
    ec2Filters.push(filter);
  }
  return ec2Filters;
}

async function getRunners(ec2Filters: Ec2Filter[]): Promise<Runners.RunnerList[]> {
  const ec2 = getTracedAWSV3Client(new EC2Client({ region: process.env.AWS_REGION }));
  const runners: Runners.RunnerList[] = [];
  let nextToken;
  let hasNext = true;
  while (hasNext) {
    const instances: DescribeInstancesResult = await ec2.send(
      new DescribeInstancesCommand({ Filters: ec2Filters, NextToken: nextToken }),
    );
    hasNext = instances.NextToken ? true : false;
    nextToken = instances.NextToken;
    runners.push(...getRunnerInfo(instances));
  }
  return runners;
}

function getRunnerInfo(runningInstances: DescribeInstancesResult) {
  const runners: Runners.RunnerList[] = [];
  if (runningInstances.Reservations) {
    for (const r of runningInstances.Reservations) {
      if (r.Instances) {
        for (const i of r.Instances) {
          runners.push({
            instanceId: i.InstanceId as string,
            launchTime: i.LaunchTime,
            owner: i.Tags?.find((e) => e.Key === 'ghr:Owner')?.Value as string,
            type: i.Tags?.find((e) => e.Key === 'ghr:Type')?.Value as string,
            repo: i.Tags?.find((e) => e.Key === 'ghr:Repo')?.Value as string,
            org: i.Tags?.find((e) => e.Key === 'ghr:Org')?.Value as string,
            orphan: i.Tags?.find((e) => e.Key === 'ghr:orphan')?.Value === 'true',
          });
        }
      }
    }
  }
  return runners;
}

export async function terminateRunner(instanceId: string): Promise<void> {
  logger.debug(`Runner '${instanceId}' will be terminated.`);
  const ec2 = getTracedAWSV3Client(new EC2Client({ region: process.env.AWS_REGION }));
  await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
  logger.debug(`Runner ${instanceId} has been terminated.`);
}

export async function tag(instanceId: string, tags: Tag[]): Promise<void> {
  logger.debug(`Tagging '${instanceId}'`, { tags });
  const ec2 = getTracedAWSV3Client(new EC2Client({ region: process.env.AWS_REGION }));
  await ec2.send(new CreateTagsCommand({ Resources: [instanceId], Tags: tags }));
}

function generateFleetOverrides(
  subnetIds: string[],
  instancesTypes: string[],
  amiId?: string,
): FleetLaunchTemplateOverridesRequest[] {
  const result: FleetLaunchTemplateOverridesRequest[] = [];
  subnetIds.forEach((s) => {
    instancesTypes.forEach((i) => {
      const item: FleetLaunchTemplateOverridesRequest = {
        SubnetId: s,
        InstanceType: i as _InstanceType,
        ImageId: amiId,
      };
      result.push(item);
    });
  });
  return result;
}

export async function createRunner(runnerParameters: Runners.RunnerInputParameters): Promise<string[]> {
  logger.debug('Runner configuration.', {
    runner: {
      configuration: {
        ...runnerParameters,
      },
    },
  });

  const ec2Client = getTracedAWSV3Client(new EC2Client({ region: process.env.AWS_REGION }));
  const amiIdOverride = await getAmiIdOverride(runnerParameters);

  const fleet: CreateFleetResult = await createInstances(runnerParameters, amiIdOverride, ec2Client);

  const instances: string[] = await processFleetResult(fleet, runnerParameters);

  logger.info(`Created instance(s): ${instances.join(',')}`);

  return instances;
}

async function processFleetResult(
  fleet: CreateFleetResult,
  runnerParameters: Runners.RunnerInputParameters,
): Promise<string[]> {
  const instances: string[] = fleet.Instances?.flatMap((i) => i.InstanceIds?.flatMap((j) => j) || []) || [];

  if (instances.length !== runnerParameters.numberOfRunners) {
    logger.warn(
      `${
        instances.length === 0 ? 'No' : instances.length + ' off ' + runnerParameters.numberOfRunners
      } instances created.`,
      { data: fleet },
    );
    const errors = fleet.Errors?.flatMap((e) => e.ErrorCode || '') || [];

    const scaleErrors = [
      'UnfulfillableCapacity',
      'MaxSpotInstanceCountExceeded',
      'TargetCapacityLimitExceededException',
      'RequestLimitExceeded',
      'ResourceLimitExceeded',
      'MaxSpotFleetRequestCountExceeded',
      'InsufficientInstanceCapacity',
    ];

    if (
      errors.some((e) => runnerParameters.onDemandFailoverOnError?.includes(e)) &&
      runnerParameters.ec2instanceCriteria.targetCapacityType === 'spot'
    ) {
      logger.warn(`Create fleet failed, initiating fall back to on demand instances.`);
      logger.debug('Create fleet failed.', { data: fleet.Errors });
      const numberOfInstances = runnerParameters.numberOfRunners - instances.length;
      const instancesOnDemand = await createRunner({
        ...runnerParameters,
        numberOfRunners: numberOfInstances,
        onDemandFailoverOnError: ['InsufficientInstanceCapacity'],
        ec2instanceCriteria: { ...runnerParameters.ec2instanceCriteria, targetCapacityType: 'on-demand' },
      });
      instances.push(...instancesOnDemand);
      return instances;
    } else if (errors.some((e) => scaleErrors.includes(e))) {
      logger.warn('Create fleet failed, ScaleError will be thrown to trigger retry for ephemeral runners.');
      logger.debug('Create fleet failed.', { data: fleet.Errors });
      throw new ScaleError('Failed to create instance, create fleet failed.');
    } else {
      logger.warn('Create fleet failed, error not recognized as scaling error.', { data: fleet.Errors });
      throw Error('Create fleet failed, no instance created.');
    }
  }
  return instances;
}

async function getAmiIdOverride(runnerParameters: Runners.RunnerInputParameters): Promise<string | undefined> {
  if (!runnerParameters.amiIdSsmParameterName) {
    return undefined;
  }

  try {
    const amiIdOverride = await getParameter(runnerParameters.amiIdSsmParameterName);
    logger.debug(`AMI override SSM parameter (${runnerParameters.amiIdSsmParameterName}) set to: ${amiIdOverride}`);
    return amiIdOverride;
  } catch (e) {
    logger.debug(
      `Failed to lookup runner AMI ID from SSM parameter: ${runnerParameters.amiIdSsmParameterName}.`,
      { error: e },
    );
    throw new Error(`Failed to lookup runner AMI ID from SSM parameter: ${runnerParameters.amiIdSsmParameterName}, ${e}`);
  }
}

async function createInstances(
  runnerParameters: Runners.RunnerInputParameters,
  amiIdOverride: string | undefined,
  ec2Client: EC2Client,
) {
  const tags = [
    { Key: 'ghr:Application', Value: 'github-action-runner' },
    { Key: 'ghr:created_by', Value: runnerParameters.numberOfRunners === 1 ? 'scale-up-lambda' : 'pool-lambda' },
    { Key: 'ghr:Type', Value: runnerParameters.runnerType },
    { Key: 'ghr:Owner', Value: runnerParameters.runnerOwner },
  ];

  if (runnerParameters.tracingEnabled) {
    const traceId = tracer.getRootXrayTraceId();
    tags.push({ Key: 'ghr:trace_id', Value: traceId! });
  }

  const createFleetCommand = new CreateFleetCommand({
    LaunchTemplateConfigs: [
      {
        LaunchTemplateSpecification: {
          LaunchTemplateName: runnerParameters.launchTemplateName,
          Version: '$Default',
        },
        Overrides: generateFleetOverrides(
          runnerParameters.subnets,
          runnerParameters.ec2instanceCriteria.instanceTypes,
          amiIdOverride,
        ),
      },
    ],
    SpotOptions: {
      MaxTotalPrice: runnerParameters.ec2instanceCriteria.maxSpotPrice,
      AllocationStrategy: runnerParameters.ec2instanceCriteria.instanceAllocationStrategy,
    },
    TargetCapacitySpecification: {
      TotalTargetCapacity: runnerParameters.numberOfRunners,
      DefaultTargetCapacityType: runnerParameters.ec2instanceCriteria.targetCapacityType,
    },
    TagSpecifications: [
      {
        ResourceType: 'instance',
        Tags: tags,
      },
      {
        ResourceType: 'volume',
        Tags: tags,
      },
    ],
    Type: 'instant',
  });
  return await ec2Client.send(createFleetCommand);
}

export function bootTimeExceeded(ec2Runner: { launchTime?: Date }): boolean {
  const runnerBootTimeInMinutes = process.env.RUNNER_BOOT_TIME_IN_MINUTES;
  const launchTimePlusBootTime = moment(ec2Runner.launchTime).utc().add(runnerBootTimeInMinutes, 'minutes');
  return launchTimePlusBootTime < moment(new Date()).utc();
}

// New: Hibernate the runner instance
export async function hibernateRunner(instanceId: string): Promise<void> {
  logger.debug(`Runner '${instanceId}' will be hibernated (stopped with hibernation).`);
  const ec2 = getTracedAWSV3Client(new EC2Client({ region: process.env.AWS_REGION }));
  // Note: Stopping an instance that supports hibernation and has hibernation configured will hibernate it.
  await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId], Hibernate: true }));
  await tag(instanceId, [{ Key: 'ghr:hibernated', Value: 'true' }]);
  logger.debug(`Runner ${instanceId} has been hibernated.`);
}

// Helper function to resume hibernated instances
export async function resumeHibernatedInstances(count: number): Promise<string[]> {
  const ec2 = getTracedAWSV3Client(new EC2Client({ region: process.env.AWS_REGION }));
  const filters: Filter[] = [
    { Name: 'instance-state-name', Values: ['stopped'] },
    { Name: 'tag:ghr:hibernated', Values: ['true'] },
    { Name: 'tag:ghr:Application', Values: ['github-action-runner'] },
  ];

  const desc = await ec2.send(new DescribeInstancesCommand({ Filters: filters }));
  const stoppedInstances = desc.Reservations?.flatMap(r => r.Instances?.map(i => i.InstanceId!) || []) || [];

  const toResume = stoppedInstances.slice(0, count);
  if (toResume.length > 0) {
    logger.info(`Resuming hibernated instances: ${toResume.join(',')}`);
    await ec2.send(new StartInstancesCommand({ InstanceIds: toResume }));
    // Optionally remove hibernated tag after start
    for (const instanceId of toResume) {
      await tag(instanceId, [{Key: 'ghr:hibernated', Value: 'false'}]);
    }
  }

  return toResume;
}