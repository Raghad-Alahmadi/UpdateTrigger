using System;
using System.Collections.Concurrent;
using System.Reactive.Linq;
using System.Reactive.Subjects;
using System.Threading.RateLimiting;
using UpdateTrigger.Models;

namespace UpdateTrigger.Services
{
    public class PostSubscriptionService
    {
        private readonly Subject<PostUpdateEvent> _postUpdateSubject = new();
        private readonly ConcurrentDictionary<string, IDisposable> _subscriptions = new();
        private readonly FixedWindowRateLimiter _rateLimiter;

        public PostSubscriptionService()
        {
            // Rate limit: 10 updates per 5 seconds
            _rateLimiter = new FixedWindowRateLimiter(new FixedWindowRateLimiterOptions
            {
                PermitLimit = 10,
                Window = TimeSpan.FromSeconds(5),
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                QueueLimit = 100
            });
        }

        public IObservable<PostUpdateEvent> GetPostUpdates()
        {
            return _postUpdateSubject.AsObservable();
        }

        public IObservable<PostUpdateEvent> GetPostUpdatesForId(int postId)
        {
            return _postUpdateSubject
                .AsObservable()
                .Where(update => update.Post.Id == postId);
        }

        public string Subscribe(Action<PostUpdateEvent> onNext, int? postId = null)
        {
            string subscriptionId = Guid.NewGuid().ToString();
            IDisposable subscription;

            if (postId.HasValue)
            {
                subscription = GetPostUpdatesForId(postId.Value).Subscribe(onNext);
            }
            else
            {
                subscription = GetPostUpdates().Subscribe(onNext);
            }

            _subscriptions[subscriptionId] = subscription;
            return subscriptionId;
        }

        public bool Unsubscribe(string subscriptionId)
        {
            if (_subscriptions.TryRemove(subscriptionId, out var subscription))
            {
                subscription.Dispose();
                return true;
            }
            return false;
        }

        public async Task PublishUpdateAsync(PostUpdateEvent updateEvent)
        {
            // Apply rate limiting
            using var lease = await _rateLimiter.AcquireAsync();

            if (lease.IsAcquired)
            {
                _postUpdateSubject.OnNext(updateEvent);
            }
        }
    }
}
