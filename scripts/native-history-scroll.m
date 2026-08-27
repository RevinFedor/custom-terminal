#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#include <math.h>
#include <unistd.h>

// Production E2E helper. It deliberately does not activate an application:
// the caller/user must put the intended Noted Terminal window in front. Before
// any wheel packet it proves that the top ordinary (layer 0) window under the
// target belongs to the exact expected PID. Cursor rollback lives in @finally.

static pid_t topOrdinaryWindowPIDAtPoint(CGPoint point) {
  CFArrayRef raw = CGWindowListCopyWindowInfo(
    kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
    kCGNullWindowID
  );
  NSArray *windows = CFBridgingRelease(raw);
  for (NSDictionary *window in windows) {
    NSNumber *layer = window[(id)kCGWindowLayer];
    if (layer && layer.integerValue != 0) continue;
    NSNumber *alpha = window[(id)kCGWindowAlpha];
    if (alpha && alpha.doubleValue <= 0.01) continue;
    NSDictionary *bounds = window[(id)kCGWindowBounds];
    CGRect rect = CGRectZero;
    if (!bounds || !CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)bounds, &rect)) continue;
    if (!CGRectContainsPoint(rect, point)) continue;
    NSNumber *owner = window[(id)kCGWindowOwnerPID];
    if (owner) return (pid_t)owner.intValue;
  }
  return 0;
}

static void warpAndMove(CGPoint point) {
  CGWarpMouseCursorPosition(point);
  CGEventRef move = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, point, kCGMouseButtonLeft);
  if (!move) return;
  CGEventPost(kCGHIDEventTap, move);
  CFRelease(move);
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 6) {
      fprintf(stderr, "usage: native-history-scroll x y profile expectedPid restoreDelayMs\n");
      return 2;
    }
    if (!CGPreflightPostEventAccess()) {
      fprintf(stderr, "CGEvent post access unavailable\n");
      return 3;
    }

    CGPoint target = CGPointMake(strtod(argv[1], NULL), strtod(argv[2], NULL));
    NSString *profile = [NSString stringWithUTF8String:argv[3]];
    pid_t expectedPID = (pid_t)strtol(argv[4], NULL, 10);
    double restoreDelayMs = strtod(argv[5], NULL);
    CGEventRef locationProbe = CGEventCreate(NULL);
    CGPoint original = locationProbe ? CGEventGetLocation(locationProbe) : target;
    if (locationProbe) CFRelease(locationProbe);

    int exitCode = 0;
    NSUInteger posted = 0;
    double total = 0;
    @try {
      warpAndMove(target);
      usleep(140000);
      pid_t observedPID = topOrdinaryWindowPIDAtPoint(target);
      if (observedPID != expectedPID) {
        fprintf(stderr, "top-window PID mismatch expected=%d observed=%d target=%.1f,%.1f\n",
          expectedPID, observedPID, target.x, target.y);
        exitCode = 4;
      } else {
        NSArray<NSString *> *packets = [profile componentsSeparatedByString:@","];
        for (NSUInteger index = 0; index < packets.count; index += 1) {
          NSArray<NSString *> *parts = [packets[index] componentsSeparatedByString:@":"];
          if (parts.count != 2) {
            fprintf(stderr, "invalid packet: %s\n", packets[index].UTF8String);
            exitCode = 5;
            break;
          }
          double delta = parts[0].doubleValue;
          double delayMs = parts[1].doubleValue;
          if (index > 0 && delayMs > 0) usleep((useconds_t)llround(delayMs * 1000.0));
          CGEventRef event = CGEventCreateScrollWheelEvent(
            NULL,
            kCGScrollEventUnitPixel,
            1,
            (int32_t)llround(delta)
          );
          if (!event) {
            fprintf(stderr, "failed to create scroll event\n");
            exitCode = 6;
            break;
          }
          CGEventSetLocation(event, target);
          CGEventSetIntegerValueField(event, kCGScrollWheelEventIsContinuous, 1);
          CGEventSetDoubleValueField(event, kCGScrollWheelEventPointDeltaAxis1, delta);
          CGEventSetDoubleValueField(event, kCGScrollWheelEventFixedPtDeltaAxis1, delta * 65536.0);
          CGEventPost(kCGHIDEventTap, event);
          CFRelease(event);
          posted += 1;
          total += delta;
        }
      }
      if (restoreDelayMs > 0) usleep((useconds_t)llround(restoreDelayMs * 1000.0));
    } @finally {
      warpAndMove(original);
    }

    if (exitCode == 0) {
      printf("transport=native expectedPid=%d packets=%lu total=%.1f original=%.1f,%.1f restored=1\n",
        expectedPID, (unsigned long)posted, total, original.x, original.y);
    }
    return exitCode;
  }
}
